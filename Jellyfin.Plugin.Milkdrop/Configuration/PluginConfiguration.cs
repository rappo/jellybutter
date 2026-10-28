using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Milkdrop.Configuration;

/// <summary>
/// The plugin settings, as the settings page saves them. Every value the client script needs is handed to it
/// as the data attribute on the injected script tag (see <see cref="WebUi.ClientSettings"/>).
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PluginConfiguration"/> class with the defaults.
    /// </summary>
    public PluginConfiguration()
    {
        Enabled = true;
        DesktopWebAudio = true;
        CycleSeconds = 30;
        BlendSeconds = 2.7;
    }

    /// <summary>
    /// Gets or sets a value indicating whether the client script is added to the web client at all. Off, the
    /// server serves jellyfin-web untouched and the asset endpoints answer 404.
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether Jellyfin Desktop plays music through the web player instead of
    /// mpv, so the visualizer can hear it. Video stays on mpv either way.
    /// </summary>
    public bool DesktopWebAudio { get; set; }

    /// <summary>
    /// Gets or sets how many seconds a preset stays before the next one is loaded. Zero turns auto-cycling off.
    /// </summary>
    public int CycleSeconds { get; set; }

    /// <summary>
    /// Gets or sets how many seconds a preset change blends over.
    /// </summary>
    public double BlendSeconds { get; set; }
}
