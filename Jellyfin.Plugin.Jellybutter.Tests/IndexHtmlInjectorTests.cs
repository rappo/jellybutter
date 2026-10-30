using System;
using System.Net;
using System.Text.Json;
using Jellyfin.Plugin.Jellybutter.WebUi;
using Xunit;

namespace Jellyfin.Plugin.Jellybutter.Tests;

public class IndexHtmlInjectorTests
{
    private const string Index = "<!doctype html><html><head><title>Jellyfin</title></head><body><div id=\"reactRoot\"></div><script defer=\"defer\" src=\"main.jellyfin.bundle.js\"></script></body></html>";

    private static readonly ClientSettings _settings = new(DesktopWebAudio: true, CycleSeconds: 30, BlendSeconds: 2.7, ControlButton: true, FloatingButton: true, NowPlayingBar: true, DefaultView: "visualizer", LyricsSize: "medium", IdleVisualizer: true, IdleMinutes: 2, IdleHideUi: true, CycleMode: "seconds", CyclesPerTrack: 1);

    [Fact]
    public void Inject_AddsTheTagBeforeBodyClose_Once()
    {
        var once = IndexHtmlInjector.Inject(Index, "1.2.3.4", _settings);

        Assert.Contains("src=\"../Jellybutter/client.js?v=1.2.3.4\"", once, StringComparison.Ordinal);
        Assert.Contains(IndexHtmlInjector.Marker, once, StringComparison.Ordinal);
        Assert.EndsWith("</script>\n</body></html>", once, StringComparison.Ordinal);

        var twice = IndexHtmlInjector.Inject(once, "1.2.3.4", _settings);
        Assert.Same(once, twice);
        Assert.Equal(1, Count(twice, "client.js"));
    }

    [Fact]
    public void Inject_TheTagIsNotDeferred_SoItRunsBeforeTheWebClientsBundles()
    {
        var tag = IndexHtmlInjector.ScriptTag("1.0", _settings);

        Assert.DoesNotContain("defer", tag, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("async", tag, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ScriptTag_CarriesTheSettingsAsHtmlSafeJson_ThatDecodesBack()
    {
        var tag = IndexHtmlInjector.ScriptTag("1.0", new ClientSettings(false, 45, 1.5, true, true, true, "visualizer", "medium", true, 2, true, "seconds", 1));

        // The JSON's own quotes are entity-encoded so the attribute's quotes survive.
        Assert.DoesNotContain("{\"", tag, StringComparison.Ordinal);
        Assert.Contains("{&quot;", tag, StringComparison.Ordinal);
        var start = tag.IndexOf(IndexHtmlInjector.ConfigAttribute + "=\"", StringComparison.Ordinal) + IndexHtmlInjector.ConfigAttribute.Length + 2;
        var end = tag.IndexOf('"', start);
        var decoded = WebUtility.HtmlDecode(tag[start..end]);

        using var json = JsonDocument.Parse(decoded);
        Assert.False(json.RootElement.GetProperty("desktopWebAudio").GetBoolean());
        Assert.Equal(45, json.RootElement.GetProperty("cycleSeconds").GetInt32());
        Assert.Equal(1.5, json.RootElement.GetProperty("blendSeconds").GetDouble());
    }

    [Fact]
    public void ScriptTag_EscapesTheVersionInTheQuery()
    {
        var tag = IndexHtmlInjector.ScriptTag("1.0 beta&x", _settings);
        Assert.Contains("?v=1.0%20beta%26x\"", tag, StringComparison.Ordinal);
    }

    [Fact]
    public void HasScript_IsTrueOnlyOnceTheTagIsThere()
    {
        Assert.False(IndexHtmlInjector.HasScript(Index));
        Assert.True(IndexHtmlInjector.HasScript(IndexHtmlInjector.Inject(Index, "1.0", _settings)));
    }

    [Theory]
    [InlineData("<html><body><h1>x</h1>")]
    [InlineData("<div>not a page</div>")]
    public void Inject_WithNoClosingBody_LeavesThePageAsItWas(string html)
    {
        var result = IndexHtmlInjector.Inject(html, "1.0", _settings);

        Assert.Same(html, result);
        Assert.False(IndexHtmlInjector.HasScript(result));
    }

    [Theory]
    [InlineData("/web/index.html", true)]
    [InlineData("/web/", true)]
    [InlineData("/web", true)]
    [InlineData("/jellyfin/web/index.html", true)]
    [InlineData("/WEB/INDEX.HTML", true)]
    [InlineData("/web/main.jellyfin.bundle.js", false)]
    [InlineData("/webhook", false)]
    [InlineData("/Items/abc", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void IsIndexRequest_MatchesOnlyTheShell(string? path, bool expected)
        => Assert.Equal(expected, ScriptInjection.IsIndexRequest(path));

    private static int Count(string haystack, string needle)
    {
        var count = 0;
        for (var i = haystack.IndexOf(needle, StringComparison.Ordinal); i >= 0; i = haystack.IndexOf(needle, i + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}
