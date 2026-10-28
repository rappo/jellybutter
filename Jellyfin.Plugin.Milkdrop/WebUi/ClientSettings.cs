using System;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.Milkdrop.Configuration;

namespace Jellyfin.Plugin.Milkdrop.WebUi;

/// <summary>
/// The settings the client script runs with, as the injected script tag carries them in its data attribute.
/// Built from the saved configuration with every value clamped to a range the script can act on, so a
/// hand-edited configuration file cannot hand the browser a negative blend or an hourly cycle.
/// </summary>
/// <param name="DesktopWebAudio">Whether Jellyfin Desktop plays music through the web player.</param>
/// <param name="CycleSeconds">Seconds between automatic preset changes; zero for none.</param>
/// <param name="BlendSeconds">Seconds a preset change blends over.</param>
public sealed record ClientSettings(bool DesktopWebAudio, int CycleSeconds, double BlendSeconds)
{
    /// <summary>
    /// The longest auto-cycle interval the script accepts, in seconds.
    /// </summary>
    public const int MaxCycleSeconds = 3600;

    /// <summary>
    /// The longest blend the script accepts, in seconds.
    /// </summary>
    public const double MaxBlendSeconds = 30;

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
        return new ClientSettings(configuration.DesktopWebAudio, cycle, blend);
    }

    /// <summary>
    /// Serializes the settings as the compact camel-case JSON the script parses out of the data attribute.
    /// </summary>
    /// <returns>The JSON.</returns>
    public string ToJson() => JsonSerializer.Serialize(this, _json);
}
