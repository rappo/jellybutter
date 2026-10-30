using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.Jellybutter.Configuration;

namespace Jellyfin.Plugin.Jellybutter.WebUi;

/// <summary>
/// The settings the client script runs with, as the injected script tag carries them in its data attribute.
/// Built from the saved configuration with every value clamped to a range the script can act on, so a
/// hand-edited configuration file cannot hand the browser a negative blend or an hourly cycle.
/// </summary>
/// <param name="DesktopWebAudio">Whether Jellyfin Desktop plays music through the web player.</param>
/// <param name="CycleSeconds">Seconds between automatic preset changes; zero for none.</param>
/// <param name="BlendSeconds">Seconds a preset change blends over.</param>
/// <param name="ControlButton">Whether the Now Playing control row gets a visualizer button.</param>
/// <param name="FloatingButton">Whether a floating visualizer button is shown on other pages.</param>
/// <param name="NowPlayingBar">Whether jellyfin-web's Now Playing bar shows along the bottom of the visualizer.</param>
/// <param name="DefaultView">The view the visualizer opens in, one of <see cref="Views"/>.</param>
/// <param name="LyricsSize">The lyrics text size, one of <see cref="LyricsSizes"/>.</param>
/// <param name="IdleVisualizer">Whether the visualizer opens by itself after idle minutes of playback.</param>
/// <param name="IdleMinutes">Minutes without input before it does, within <see cref="MinIdleMinutes"/>..<see cref="MaxIdleMinutes"/>.</param>
/// <param name="IdleHideUi">Whether the UI minimizes when idle (the idle visualizer opens minimized).</param>
/// <param name="CycleMode">How presets change by themselves, one of <see cref="CycleModes"/>.</param>
/// <param name="CyclesPerTrack">Preset changes per song in the "track" mode, within 1..<see cref="MaxCyclesPerTrack"/>.</param>
/// <param name="LikeWeight">How many times as likely a liked preset is, within <see cref="MinLikeWeight"/>..<see cref="MaxLikeWeight"/>.</param>
/// <param name="LikedOnly">Whether only liked presets come up.</param>
/// <param name="PresetPacks">The optional preset packs in use, of <see cref="Packs"/>.</param>
public sealed record ClientSettings(
    bool DesktopWebAudio,
    int CycleSeconds,
    double BlendSeconds,
    bool ControlButton,
    bool FloatingButton,
    bool NowPlayingBar,
    string DefaultView,
    string LyricsSize,
    bool IdleVisualizer,
    int IdleMinutes,
    bool IdleHideUi,
    string CycleMode,
    int CyclesPerTrack,
    int LikeWeight,
    bool LikedOnly,
    IReadOnlyList<string> PresetPacks)
{
    /// <summary>
    /// The optional preset packs, by the names the asset endpoint and the script use.
    /// </summary>
    public static readonly string[] Packs = ["extra", "extra2", "md1"];

    /// <summary>
    /// The smallest like weight the script accepts.
    /// </summary>
    public const int MinLikeWeight = 2;

    /// <summary>
    /// The largest like weight the script accepts.
    /// </summary>
    public const int MaxLikeWeight = 10;

    /// <summary>
    /// The ways presets change by themselves; the first is the default.
    /// </summary>
    public static readonly string[] CycleModes = ["seconds", "track"];

    /// <summary>
    /// The most preset changes per song the script accepts.
    /// </summary>
    public const int MaxCyclesPerTrack = 20;

    /// <summary>
    /// The views the visualizer can open in; the first is the default.
    /// </summary>
    public static readonly string[] Views = ["visualizer", "lyrics"];

    /// <summary>
    /// The lyrics text sizes; the second is the default.
    /// </summary>
    public static readonly string[] LyricsSizes = ["small", "medium", "large"];

    /// <summary>
    /// The longest auto-cycle interval the script accepts, in seconds.
    /// </summary>
    public const int MaxCycleSeconds = 3600;

    /// <summary>
    /// The longest blend the script accepts, in seconds.
    /// </summary>
    public const double MaxBlendSeconds = 30;

    /// <summary>
    /// The shortest idle time the script accepts, in minutes.
    /// </summary>
    public const int MinIdleMinutes = 1;

    /// <summary>
    /// The longest idle time the script accepts, in minutes.
    /// </summary>
    public const int MaxIdleMinutes = 60;

    private static readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never
    };

    /// <summary>
    /// Gets the settings for a configuration, or <see langword="null"/> when the plugin is switched off or has
    /// no configuration yet (the host has not finished loading it), in which case nothing is injected.
    /// </summary>
    /// <param name="configuration">The saved configuration.</param>
    /// <returns>The clamped settings, or <see langword="null"/> when the script must not be injected.</returns>
    public static ClientSettings? FromConfiguration(PluginConfiguration? configuration)
    {
        if (configuration is null || !configuration.Enabled)
        {
            return null;
        }

        var cycle = Math.Clamp(configuration.CycleSeconds, 0, MaxCycleSeconds);
        var blend = double.IsFinite(configuration.BlendSeconds) ? Math.Clamp(configuration.BlendSeconds, 0, MaxBlendSeconds) : 0;
        return new ClientSettings(
            configuration.DesktopWebAudio,
            cycle,
            blend,
            configuration.ControlButton,
            configuration.FloatingButton,
            configuration.NowPlayingBar,
            PickOne(configuration.DefaultView, Views, Views[0]),
            PickOne(configuration.LyricsSize, LyricsSizes, LyricsSizes[1]),
            configuration.IdleVisualizer,
            Math.Clamp(configuration.IdleMinutes, MinIdleMinutes, MaxIdleMinutes),
            configuration.IdleHideUi,
            PickOne(configuration.CycleMode, CycleModes, CycleModes[0]),
            Math.Clamp(configuration.CyclesPerTrack, 1, MaxCyclesPerTrack),
            Math.Clamp(configuration.LikeWeight, MinLikeWeight, MaxLikeWeight),
            configuration.LikedOnly,
            PacksOf(configuration));
    }

    private static string[] PacksOf(PluginConfiguration configuration)
    {
        var on = new[] { configuration.PackExtra, configuration.PackExtra2, configuration.PackMd1 };
        return Packs.Where((_, i) => on[i]).ToArray();
    }

    private static string PickOne(string? value, string[] allowed, string fallback)
    {
        var lower = value?.Trim().ToLowerInvariant();
        return lower is not null && Array.IndexOf(allowed, lower) >= 0 ? lower : fallback;
    }

    /// <summary>
    /// Serializes the settings as the compact camel-case JSON the script parses out of the data attribute.
    /// </summary>
    /// <returns>The JSON.</returns>
    public string ToJson() => JsonSerializer.Serialize(this, _json);
}
