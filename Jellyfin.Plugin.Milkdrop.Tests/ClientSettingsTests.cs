using Jellyfin.Plugin.Milkdrop.Configuration;
using Jellyfin.Plugin.Milkdrop.WebUi;
using Xunit;

namespace Jellyfin.Plugin.Milkdrop.Tests;

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

        var settings = ClientSettings.FromConfiguration(config);
        Assert.Equal(new ClientSettings(true, 30, 2.7), settings);
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
        var json = new ClientSettings(false, 0, 2.7).ToJson();

        Assert.Equal("{\"desktopWebAudio\":false,\"cycleSeconds\":0,\"blendSeconds\":2.7}", json);
    }
}
