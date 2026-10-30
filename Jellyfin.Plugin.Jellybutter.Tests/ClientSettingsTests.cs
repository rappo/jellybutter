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
        Assert.True(config.IdleVisualizer);
        Assert.Equal(2, config.IdleMinutes);
        Assert.True(config.IdleHideUi);

        // Compared as the JSON the script gets: the record compares its pack list by reference.
        var settings = ClientSettings.FromConfiguration(config)!;
        Assert.Equal(new ClientSettings(true, 30, 2.7, true, true, true, "visualizer", "medium", true, 2, true, "seconds", 1, 3, false, ClientSettings.Packs).ToJson(), settings.ToJson());
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

    [Theory]
    [InlineData(2, 2)]
    [InlineData(0, 1)]
    [InlineData(-5, 1)]
    [InlineData(60, 60)]
    [InlineData(600, 60)]
    public void IdleMinutes_IsClampedToTheRangeTheScriptAccepts(int saved, int expected)
        => Assert.Equal(expected, ClientSettings.FromConfiguration(new PluginConfiguration { IdleMinutes = saved })!.IdleMinutes);

    [Fact]
    public void IdleSwitches_PassThrough()
    {
        var settings = ClientSettings.FromConfiguration(new PluginConfiguration { IdleVisualizer = false, IdleHideUi = false })!;

        Assert.False(settings.IdleVisualizer);
        Assert.False(settings.IdleHideUi);
    }

    [Fact]
    public void ButtonSwitches_PassThrough()
    {
        var settings = ClientSettings.FromConfiguration(new PluginConfiguration { ControlButton = false, FloatingButton = false, NowPlayingBar = false })!;

        Assert.False(settings.ControlButton);
        Assert.False(settings.FloatingButton);
        Assert.False(settings.NowPlayingBar);
    }

    [Theory]
    [InlineData(3, 3)]
    [InlineData(1, ClientSettings.MinLikeWeight)]
    [InlineData(-4, ClientSettings.MinLikeWeight)]
    [InlineData(50, ClientSettings.MaxLikeWeight)]
    public void LikeWeight_IsClamped(int saved, int expected)
        => Assert.Equal(expected, ClientSettings.FromConfiguration(new PluginConfiguration { LikeWeight = saved })!.LikeWeight);

    [Fact]
    public void PresetPacks_ListOnlyThePacksSwitchedOn_InAFixedOrder()
    {
        Assert.Equal(["extra", "extra2", "md1"], ClientSettings.FromConfiguration(new PluginConfiguration())!.PresetPacks);
        Assert.Equal(["extra2"], ClientSettings.FromConfiguration(new PluginConfiguration { PackExtra = false, PackMd1 = false })!.PresetPacks);
        Assert.Empty(ClientSettings.FromConfiguration(new PluginConfiguration { PackExtra = false, PackExtra2 = false, PackMd1 = false })!.PresetPacks);
    }

    [Fact]
    public void LikedOnly_PassesThrough()
        => Assert.True(ClientSettings.FromConfiguration(new PluginConfiguration { LikedOnly = true })!.LikedOnly);

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
    [InlineData("track", "track")]
    [InlineData(" Track ", "track")]
    [InlineData("album", "seconds")]
    [InlineData(null, "seconds")]
    public void CycleMode_IsOneOfTheKnownModes(string? saved, string expected)
        => Assert.Equal(expected, ClientSettings.FromConfiguration(new PluginConfiguration { CycleMode = saved! })!.CycleMode);

    [Theory]
    [InlineData(1, 1)]
    [InlineData(0, 1)]
    [InlineData(-3, 1)]
    [InlineData(4, 4)]
    [InlineData(500, ClientSettings.MaxCyclesPerTrack)]
    public void CyclesPerTrack_IsClamped(int saved, int expected)
        => Assert.Equal(expected, ClientSettings.FromConfiguration(new PluginConfiguration { CyclesPerTrack = saved })!.CyclesPerTrack);

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
        var json = new ClientSettings(false, 0, 2.7, true, false, true, "lyrics", "large", true, 2, true, "track", 3, 5, true, ["md1"]).ToJson();

        Assert.Equal("{\"desktopWebAudio\":false,\"cycleSeconds\":0,\"blendSeconds\":2.7,\"controlButton\":true,\"floatingButton\":false,\"nowPlayingBar\":true,\"defaultView\":\"lyrics\",\"lyricsSize\":\"large\",\"idleVisualizer\":true,\"idleMinutes\":2,\"idleHideUi\":true,\"cycleMode\":\"track\",\"cyclesPerTrack\":3,\"likeWeight\":5,\"likedOnly\":true,\"presetPacks\":[\"md1\"]}", json);
    }
}
