using System;
using System.IO;
using Jellyfin.Plugin.Jellybutter.Configuration;
using Xunit;

namespace Jellyfin.Plugin.Jellybutter.Tests;

public sealed class LegacyConfigurationTests : IDisposable
{
    private const string Current = "Jellyfin.Plugin.Jellybutter.xml";

    private readonly string _dir = Directory.CreateTempSubdirectory("jellybutter-config-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private string PathOf(string name) => Path.Combine(_dir, name);

    [Fact]
    public void OnlyTheLegacyFile_IsCopiedToTheCurrentName_AndKept()
    {
        File.WriteAllText(PathOf(LegacyConfiguration.FileName), "<PluginConfiguration><CycleSeconds>45</CycleSeconds></PluginConfiguration>");

        Assert.True(LegacyConfiguration.CopyIfMissing(_dir, Current));

        Assert.Equal(File.ReadAllText(PathOf(LegacyConfiguration.FileName)), File.ReadAllText(PathOf(Current)));
        Assert.True(File.Exists(PathOf(LegacyConfiguration.FileName)));
    }

    [Fact]
    public void AnExistingCurrentFile_IsNeverOverwritten()
    {
        File.WriteAllText(PathOf(LegacyConfiguration.FileName), "old");
        File.WriteAllText(PathOf(Current), "new");

        Assert.False(LegacyConfiguration.CopyIfMissing(_dir, Current));

        Assert.Equal("new", File.ReadAllText(PathOf(Current)));
    }

    [Fact]
    public void AFreshInstall_HasNothingToCopy()
    {
        Assert.False(LegacyConfiguration.CopyIfMissing(_dir, Current));

        Assert.False(File.Exists(PathOf(Current)));
    }
}
