using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Jellybutter.Presets;

/// <summary>
/// A vote as the client sends it.
/// </summary>
/// <param name="Preset">The preset name.</param>
/// <param name="Vote">"like", "block", or "none" to clear.</param>
public sealed record PresetVoteRequest(
    [property: JsonPropertyName("preset")] string? Preset,
    [property: JsonPropertyName("vote")] string? Vote);
