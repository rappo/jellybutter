using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Jellybutter.Presets;

/// <summary>
/// The liked and blocked presets one user's visualizer goes by.
/// </summary>
/// <param name="Likes">Liked preset names, sorted.</param>
/// <param name="Blocks">Blocked preset names, sorted.</param>
public sealed record PresetVoteSummary(
    [property: JsonPropertyName("likes")] IReadOnlyList<string> Likes,
    [property: JsonPropertyName("blocks")] IReadOnlyList<string> Blocks);
