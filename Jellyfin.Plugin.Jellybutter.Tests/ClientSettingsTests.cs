using Jellyfin.Plugin.Jellybutter.Configuration;
using Jellyfin.Plugin.Jellybutter.WebUi;
using Xunit;

namespace Jellyfin.Plugin.Jellybutter.Tests;

public class ClientSettingsTests
{
    [Fact]
    public void Defaults_AreOnWithACrescendoLikeCycleAndBlend()
    {
        var config = new PluginConfiguration();

        Assert.True(config.Enabled);
        Assert.True(config.DesktopWebAudio);
        Assert.Equal(30, config.CycleSeconds);
        Assert.Equal(2.7, config.BlendSeconds);
        Assert.True(config.ControlButton);
        Assert.True(config.FloatingButton);
        Assert.True(config.NowPlayingBar);
        Assert.Equal("visualizer", config.DefaultView);
        Assert.Equal("medium", config.LyricsSize);

        var settings = ClientSettings.FromConfiguration(config);
        Assert.Equal(new ClientSettings(true, 30, 2.7, true, true, true, "visualizer", "medium"), settings);
    }

    [Theory]
    [InlineData("lyrics", "lyrics")]
    [InlineData("Lyrics", "lyrics")]
    [InlineData(" VISUALIZER ", "visualizer")]
    [InlineData("karaoke", "visualizer")]
    [InlineData("", "visualizer")]
    [InlineData(null, "visualizer")]
    public void DefaultView_IsOneOfTheKnownViews(string? saved, string expected)
        => Assert.Equal(expected, ClientSettings.FromConfiguration(new PluginConfiguration { DefaultView = saved! })!.DefaultView);

    [Theory]
    [InlineData("large", "large")]
    [InlineData("Small", "small")]
    [InlineData("huge", "medium")]
    [InlineData(null, "medium")]
    public void LyricsSize_IsOneOfTheKnownSizes(string? saved, string expected)
        => Assert.Equal(expected, ClientSettings.FromConfiguration(new PluginConfiguration { LyricsSize = saved! })!.LyricsSize);

    [Fact]
    public void ButtonSwitches_PassThrough()
    {
        var settings = ClientSettings.FromConfiguration(new PluginConfiguration { ControlButton = false, FloatingButton = false, NowPlayingBar = false })!;

        Assert.False(settings.ControlButton);
        Assert.False(settings.FloatingButton);
        Assert.False(settings.NowPlayingBar);
    }

    [Fact]
    public void SwitchedOffOrMissing_YieldsNothingToInject()
    {
        Assert.Null(ClientSettings.FromConfiguration(null));
        Assert.Null(ClientSettings.FromConfiguration(new PluginConfiguration { Enabled = false }));
    }

    [Theory]
    [InlineData(-5, 0)]
    [InlineData(0, 0)]
    [InlineData(45, 45)]
    [InlineData(999999, ClientSettings.MaxCycleSeconds)]
    public void CycleSeconds_IsClamped(int saved, int expected)
        => Assert.Equal(expected, ClientSettings.FromConfiguration(new PluginConfiguration { CycleSeconds = saved })!.CycleSeconds);

    [Theory]
    [InlineData(-1.0, 0.0)]
    [InlineData(1.5, 1.5)]
    [InlineData(100.0, ClientSettings.MaxBlendSeconds)]
    [InlineData(double.NaN, 0.0)]
    [InlineData(double.PositiveInfinity, 0.0)]
    public void BlendSeconds_IsClampedAndFinite(double saved, double expected)
        => Assert.Equal(expected, ClientSettings.FromConfiguration(new PluginConfiguration { BlendSeconds = saved })!.BlendSeconds);

    [Fact]
    public void ToJson_IsCompactCamelCase_AsTheScriptParsesIt()
    {
        var json = new ClientSettings(false, 0, 2.7, true, false, true, "lyrics", "large").ToJson();

        Assert.Equal("{\"desktopWebAudio\":false,\"cycleSeconds\":0,\"blendSeconds\":2.7,\"controlButton\":true,\"floatingButton\":false,\"nowPlayingBar\":true,\"defaultView\":\"lyrics\",\"lyricsSize\":\"large\"}", json);
    }
}
