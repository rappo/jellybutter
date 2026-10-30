using System;
using System.Text;
using Jellyfin.Plugin.Jellybutter.Api;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;
using Xunit;

namespace Jellyfin.Plugin.Jellybutter.Tests;

// The asset endpoints serve files compiled into the plugin. The Butterchurn ones prove the npm bundles
// were embedded by the build: a missing node_modules would otherwise only show up in a browser.
public class JellybutterControllerTests
{
    private static JellybutterController Controller(bool enabled = true, string? version = null)
    {
        var controller = new JellybutterController(() => enabled)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };
        if (version is not null)
        {
            controller.HttpContext.Request.QueryString = new QueryString("?v=" + Uri.EscapeDataString(version));
        }

        return controller;
    }

    private static FileContentResult File(IActionResult result)
    {
        var file = Assert.IsType<FileContentResult>(result);
        Assert.Equal("application/javascript", file.ContentType);
        Assert.NotNull(file.EntityTag);
        Assert.NotEmpty(file.FileContents);
        return file;
    }

    [Fact]
    public void TheClientScript_IsServed_WithItsContentHashAsTag()
    {
        var file = File(Controller().GetClientScript(null));

        var text = Encoding.UTF8.GetString(file.FileContents);
        Assert.Contains("JellybutterCore", text, StringComparison.Ordinal);
        Assert.Contains("filterNativePlugins", text, StringComparison.Ordinal);
        Assert.Equal(64 + 2, file.EntityTag!.Tag.Length);
    }

    [Fact]
    public void TheButterchurnBundles_AreEmbedded_AndDefineTheirGlobals()
    {
        var engine = Encoding.UTF8.GetString(File(Controller().GetButterchurn(null)).FileContents);
        var presets = Encoding.UTF8.GetString(File(Controller().GetPresets(null)).FileContents);

        Assert.Contains("butterchurn=", engine, StringComparison.Ordinal);
        Assert.Contains("createVisualizer", engine, StringComparison.Ordinal);
        Assert.Contains("butterchurnPresets=", presets, StringComparison.Ordinal);
        Assert.Contains("getPresets", presets, StringComparison.Ordinal);
        Assert.True(engine.Length > 100_000, "the engine bundle is far smaller than butterchurn 2.6.7");
        Assert.True(presets.Length > 100_000, "the presets bundle is far smaller than butterchurn-presets 2.4.7");
    }

    [Theory]
    [InlineData("extra", "butterchurnPresetsExtra=")]
    [InlineData("extra2", "butterchurnPresetsExtra2=")]
    [InlineData("md1", "butterchurnPresetsMD1=")]
    public void TheOptionalPresetPacks_AreEmbedded_AndDefineTheirGlobals(string pack, string global)
    {
        var text = Encoding.UTF8.GetString(File(Controller().GetPresetPack(pack, null)).FileContents);

        Assert.Contains(global, text, StringComparison.Ordinal);
        Assert.Contains("getPresets", text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("base")]
    [InlineData("Extra")]
    [InlineData("../client")]
    public void AnUnknownPack_Is404(string pack)
        => Assert.IsType<NotFoundResult>(Controller().GetPresetPack(pack, null));

    [Fact]
    public void WhenSwitchedOff_EveryAssetIs404()
    {
        Assert.IsType<NotFoundResult>(Controller(enabled: false).GetClientScript(null));
        Assert.IsType<NotFoundResult>(Controller(enabled: false).GetButterchurn(null));
        Assert.IsType<NotFoundResult>(Controller(enabled: false).GetPresets(null));
        Assert.IsType<NotFoundResult>(Controller(enabled: false).GetPresetPack("extra", null));
    }

    [Fact]
    public void ARequestNamingTheCurrentVersion_IsImmutableForAYear_AnyOtherRevalidates()
    {
        Assert.Equal("public, max-age=31536000, immutable", JellybutterController.CacheControlFor("1.2.3.4", "1.2.3.4"));
        Assert.Equal("public, no-cache", JellybutterController.CacheControlFor("1.2.3.3", "1.2.3.4"));
        Assert.Equal("public, no-cache", JellybutterController.CacheControlFor(null, "1.2.3.4"));
        Assert.Equal("public, no-cache", JellybutterController.CacheControlFor(string.Empty, "1.2.3.4"));
    }

    [Fact]
    public void TheCacheHeader_FollowsTheRunningVersion()
    {
        var current = Controller(version: Plugin.VersionString);
        current.GetClientScript(Plugin.VersionString);
        Assert.Equal("public, max-age=31536000, immutable", current.HttpContext.Response.Headers[HeaderNames.CacheControl]);

        var stale = Controller(version: "0.0.0.0");
        stale.GetClientScript("0.0.0.0");
        Assert.Equal("public, no-cache", stale.HttpContext.Response.Headers[HeaderNames.CacheControl]);
    }

    [Fact]
    public void TheVersion_ComesFromMetaJson()
    {
        // Directory.Build.props reads meta.json; a mismatch would hand browsers a cache buster that never moves.
        Assert.Matches(@"^\d+\.\d+\.\d+\.\d+$", Plugin.VersionString);
        Assert.NotEqual("0.0.0.0", Plugin.VersionString);
        Assert.NotEqual("1.0.0", Plugin.VersionString);
    }
}
