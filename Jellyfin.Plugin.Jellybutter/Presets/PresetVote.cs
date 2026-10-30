using System;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Jellybutter.Presets;

/// <summary>
/// One user's latest vote on one preset, as stored. A cleared vote is kept (with no <see cref="Vote"/>) so the
/// shared list can tell that the latest word on a preset was "neither".
/// </summary>
/// <param name="Preset">The preset name, as Butterchurn's preset packs key it.</param>
/// <param name="UserId">The Jellyfin user who voted.</param>
/// <param name="Vote"><see cref="PresetVoteBook.Like"/>, <see cref="PresetVoteBook.Block"/>, or <see langword="null"/> once cleared.</param>
/// <param name="At">When the vote was cast.</param>
public sealed record PresetVote(
    [property: JsonPropertyName("preset")] string Preset,
    [property: JsonPropertyName("userId")] Guid UserId,
    [property: JsonPropertyName("vote")] string? Vote,
    [property: JsonPropertyName("at")] DateTimeOffset At);
