using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Jellybutter.Configuration;

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
        CycleMode = "seconds";
        CycleSeconds = 30;
        CyclesPerTrack = 1;
        BlendSeconds = 2.7;
        ControlButton = true;
        FloatingButton = true;
        NowPlayingBar = true;
        DefaultView = "visualizer";
        LyricsSize = "medium";
        IdleVisualizer = true;
        IdleMinutes = 2;
        IdleHideUi = true;
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
    /// Gets or sets how presets change by themselves: "seconds" (every <see cref="CycleSeconds"/>) or "track"
    /// (<see cref="CyclesPerTrack"/> times per song).
    /// </summary>
    public string CycleMode { get; set; }

    /// <summary>
    /// Gets or sets how many seconds a preset stays before the next one is loaded. Zero turns auto-cycling off.
    /// </summary>
    public int CycleSeconds { get; set; }

    /// <summary>
    /// Gets or sets how many times per song the preset changes in the "track" mode: once at the start of each
    /// track, and again at each equal slice of it after the first.
    /// </summary>
    public int CyclesPerTrack { get; set; }

    /// <summary>
    /// Gets or sets how many seconds a preset change blends over.
    /// </summary>
    public double BlendSeconds { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the Now Playing control row gets a visualizer button, between
    /// Lyrics and Shuffle.
    /// </summary>
    public bool ControlButton { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether a floating visualizer button is shown while a track is loaded,
    /// on pages without the Now Playing control row.
    /// </summary>
    public bool FloatingButton { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether jellyfin-web's Now Playing bar (artwork, track, artist and the
    /// playback controls) is shown along the bottom of the visualizer while it is open.
    /// </summary>
    public bool NowPlayingBar { get; set; }

    /// <summary>
    /// Gets or sets which view the visualizer opens in: "visualizer" or "lyrics" (the visualizer with the
    /// track's lyrics over it).
    /// </summary>
    public string DefaultView { get; set; }

    /// <summary>
    /// Gets or sets the lyrics text size: "small", "medium" or "large".
    /// </summary>
    public string LyricsSize { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the visualizer opens by itself, full screen, when music has been
    /// playing with no input for <see cref="IdleMinutes"/>.
    /// </summary>
    public bool IdleVisualizer { get; set; }

    /// <summary>
    /// Gets or sets how many minutes without input, while music plays, open the idle visualizer.
    /// </summary>
    public int IdleMinutes { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the UI minimizes when idle: the idle visualizer opens with its
    /// controls hidden (no buttons and no bar background, only the track, artwork, time and progress), and a
    /// visualizer opened by hand hides them after <see cref="IdleMinutes"/> without input.
    /// </summary>
    public bool IdleHideUi { get; set; }
}
