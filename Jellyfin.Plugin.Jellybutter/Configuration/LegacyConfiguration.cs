using System.IO;

namespace Jellyfin.Plugin.Jellybutter.Configuration;

/// <summary>
/// Carries the settings over from the plugin's name before Jellybutter. Jellyfin names a plugin's
/// configuration file after its assembly (<c>BasePlugin&lt;T&gt;.ConfigurationFileName</c> is the DLL name with
/// <c>.xml</c>), so renaming <c>Jellyfin.Plugin.Milkdrop.dll</c> to <c>Jellyfin.Plugin.Jellybutter.dll</c> would
/// otherwise start every server on the defaults.
/// </summary>
public static class LegacyConfiguration
{
    /// <summary>
    /// The configuration file name of versions up to 1.1.0.0, published as "Milkdrop Visualizer".
    /// </summary>
    public const string FileName = "Jellyfin.Plugin.Milkdrop.xml";

    /// <summary>
    /// Copies the legacy configuration file to the current name when only the legacy one exists. A copy, not
    /// a move: the old version stays installed (superseded) until it is removed, and rolling back to it
    /// still finds its settings.
    /// </summary>
    /// <param name="directory">The plugin configurations folder.</param>
    /// <param name="currentFileName">The configuration file name of the running assembly.</param>
    /// <returns><see langword="true"/> when the settings were copied.</returns>
    public static bool CopyIfMissing(string directory, string currentFileName)
    {
        var current = Path.Combine(directory, currentFileName);
        var legacy = Path.Combine(directory, FileName);
        if (File.Exists(current) || !File.Exists(legacy))
        {
            return false;
        }

        File.Copy(legacy, current);
        return true;
    }
}
