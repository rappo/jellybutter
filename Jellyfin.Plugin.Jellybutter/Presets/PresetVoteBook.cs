using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.Jellybutter.Presets;

/// <summary>
/// The like and block votes on presets: every user's latest vote on each preset, always recorded with the
/// user, so the server-wide list and the per-user lists come out of the same records and switching between
/// them applies to every vote already cast.
/// </summary>
public sealed class PresetVoteBook
{
    /// <summary>
    /// A like: the preset comes up more often.
    /// </summary>
    public const string Like = "like";

    /// <summary>
    /// A block: the preset never comes up.
    /// </summary>
    public const string Block = "block";

    /// <summary>
    /// The longest preset name accepted; the packs' longest is well under it.
    /// </summary>
    public const int MaxPresetLength = 400;

    private readonly Dictionary<(string Preset, Guid UserId), PresetVote> _votes = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="PresetVoteBook"/> class from stored votes, keeping the
    /// latest per user and preset should the store hold more than one.
    /// </summary>
    /// <param name="votes">The stored votes, if any.</param>
    public PresetVoteBook(IEnumerable<PresetVote>? votes = null)
    {
        foreach (var vote in votes ?? [])
        {
            if (IsValidPreset(vote.Preset) && (vote.Vote is null || NormalizeVote(vote.Vote) is not null))
            {
                Record(vote with { Vote = vote.Vote is null ? null : NormalizeVote(vote.Vote) });
            }
        }
    }

    /// <summary>
    /// Gets every recorded vote, cleared ones included, oldest first.
    /// </summary>
    public IReadOnlyList<PresetVote> Votes => _votes.Values.OrderBy(v => v.At).ThenBy(v => v.Preset, StringComparer.Ordinal).ToList();

    /// <summary>
    /// The vote a request names: <see cref="Like"/> or <see cref="Block"/> (any casing), or null for anything
    /// else.
    /// </summary>
    /// <param name="vote">The vote as sent.</param>
    /// <returns>The normalized vote, or <see langword="null"/>.</returns>
    public static string? NormalizeVote(string? vote) => vote?.Trim().ToLowerInvariant() switch
    {
        Like => Like,
        Block => Block,
        _ => null
    };

    /// <summary>
    /// Whether a preset name can be voted on: not blank and not absurdly long.
    /// </summary>
    /// <param name="preset">The preset name.</param>
    /// <returns><see langword="true"/> when it can.</returns>
    public static bool IsValidPreset(string? preset) => !string.IsNullOrWhiteSpace(preset) && preset.Length <= MaxPresetLength;

    /// <summary>
    /// Records a user's vote on a preset, replacing their earlier one; <see langword="null"/> clears it.
    /// </summary>
    /// <param name="preset">The preset name.</param>
    /// <param name="userId">The voting user.</param>
    /// <param name="vote"><see cref="Like"/>, <see cref="Block"/> or <see langword="null"/>.</param>
    /// <param name="at">When.</param>
    public void Cast(string preset, Guid userId, string? vote, DateTimeOffset at)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(preset);
        Record(new PresetVote(preset, userId, vote is null ? null : NormalizeVote(vote) ?? throw new ArgumentException("Not a vote: " + vote, nameof(vote)), at));
    }

    /// <summary>
    /// Forgets the votes on one preset, or on every preset, from every user.
    /// </summary>
    /// <param name="preset">The preset, or <see langword="null"/> for all.</param>
    /// <returns>How many votes were forgotten.</returns>
    public int Clear(string? preset)
    {
        var keys = _votes.Keys.Where(k => preset is null || string.Equals(k.Preset, preset, StringComparison.Ordinal)).ToList();
        keys.ForEach(k => _votes.Remove(k));
        return keys.Count;
    }

    /// <summary>
    /// The likes and blocks a user's visualizer goes by. Shared: the latest vote on each preset from anyone,
    /// so one user can undo another's. Per user: only that user's own votes.
    /// </summary>
    /// <param name="userId">The user.</param>
    /// <param name="perUser">Whether every user keeps their own list.</param>
    /// <returns>The liked and blocked presets.</returns>
    public PresetVoteSummary For(Guid userId, bool perUser)
    {
        var current = _votes.Values
            .Where(v => !perUser || v.UserId == userId)
            .GroupBy(v => v.Preset, StringComparer.Ordinal)
            .Select(g => g.OrderByDescending(v => v.At).First())
            .Where(v => v.Vote is not null)
            .ToList();
        List<string> Named(string vote) => current.Where(v => v.Vote == vote).Select(v => v.Preset).Order(StringComparer.Ordinal).ToList();
        return new PresetVoteSummary(Named(Like), Named(Block));
    }

    private void Record(PresetVote vote)
    {
        var key = (vote.Preset, vote.UserId);
        if (!_votes.TryGetValue(key, out var existing) || existing.At <= vote.At)
        {
            _votes[key] = vote;
        }
    }
}
