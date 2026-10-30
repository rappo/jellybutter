using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.Jellybutter.Configuration;
using Jellyfin.Plugin.Jellybutter.Presets;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Jellybutter.Api;

/// <summary>
/// Likes and blocks on presets. Any signed-in user reads the list their visualizer goes by and votes; every
/// vote is stored with its user, and the "per user" setting decides whether a user sees everyone's latest
/// votes or only their own. Administrators list every vote and clear them.
/// </summary>
[ApiController]
[Route("Jellybutter/Presets/Votes")]
[Authorize]
public class PresetVotesController : ControllerBase
{
    // Jellyfin's administrator policy, as Jellyfin.Api names it (not a package a plugin can reference).
    private const string RequiresElevation = "RequiresElevation";

    private readonly PresetVoteStore _store;
    private readonly Func<HttpContext, Task<Guid?>> _userOf;
    private readonly Func<PluginConfiguration?> _configuration;
    private readonly Func<DateTimeOffset> _now;

    /// <summary>
    /// Initializes a new instance of the <see cref="PresetVotesController"/> class.
    /// </summary>
    /// <param name="store">The vote store.</param>
    /// <param name="authorization">Resolves the calling user.</param>
    public PresetVotesController(PresetVoteStore store, IAuthorizationContext authorization)
        : this(store, context => UserOf(authorization, context), () => Plugin.Instance?.Configuration, () => DateTimeOffset.UtcNow)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="PresetVotesController"/> class with explicit settings and
    /// clock. Test seam: a test has no plugin instance, nor a signed-in user (AuthorizationInfo's user id
    /// comes from its user entity).
    /// </summary>
    /// <param name="store">The vote store.</param>
    /// <param name="userOf">The calling user's id, or null when there is none.</param>
    /// <param name="configuration">The plugin settings, read per request.</param>
    /// <param name="now">The clock votes are stamped with.</param>
    internal PresetVotesController(PresetVoteStore store, Func<HttpContext, Task<Guid?>> userOf, Func<PluginConfiguration?> configuration, Func<DateTimeOffset> now)
    {
        _store = store;
        _userOf = userOf;
        _configuration = configuration;
        _now = now;
    }

    /// <summary>
    /// Gets the likes and blocks the calling user's visualizer goes by.
    /// </summary>
    /// <returns>The liked and blocked presets.</returns>
    [HttpGet]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<PresetVoteSummary>> GetVotes()
    {
        var config = _configuration();
        var user = await _userOf(HttpContext).ConfigureAwait(false);
        if (config is null || !config.Enabled || user is null)
        {
            return NotFound();
        }

        return _store.Read(book => book.For(user.Value, config.VotesPerUser));
    }

    /// <summary>
    /// Likes, blocks or clears a preset for the calling user.
    /// </summary>
    /// <param name="request">The preset and the vote (like, block, or none to clear).</param>
    /// <returns>The calling user's likes and blocks after the vote.</returns>
    [HttpPost]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<PresetVoteSummary>> Vote([FromBody] PresetVoteRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var config = _configuration();
        var user = await _userOf(HttpContext).ConfigureAwait(false);
        if (config is null || !config.Enabled || user is null)
        {
            return NotFound();
        }

        var vote = PresetVoteBook.NormalizeVote(request.Vote);
        var clear = string.Equals(request.Vote?.Trim(), "none", StringComparison.OrdinalIgnoreCase);
        if (!PresetVoteBook.IsValidPreset(request.Preset) || (vote is null && !clear))
        {
            return BadRequest();
        }

        var at = _now();
        return _store.Update(book =>
        {
            book.Cast(request.Preset!, user.Value, vote, at);
            return book.For(user.Value, config.VotesPerUser);
        });
    }

    /// <summary>
    /// Lists every vote from every user, for the settings page.
    /// </summary>
    /// <returns>All votes, cleared ones left out.</returns>
    [HttpGet("All")]
    [Authorize(Policy = RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<PresetVote>> GetAllVotes()
        => Ok(_store.Read(book => book.Votes.Where(v => v.Vote is not null).ToList()));

    /// <summary>
    /// Forgets the votes on one preset, or on every preset, from every user.
    /// </summary>
    /// <param name="preset">The preset, or none for all.</param>
    /// <returns>No content.</returns>
    [HttpDelete]
    [Authorize(Policy = RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public IActionResult ClearVotes([FromQuery] string? preset)
    {
        _store.Update(book => book.Clear(string.IsNullOrEmpty(preset) ? null : preset));
        return NoContent();
    }

    private static async Task<Guid?> UserOf(IAuthorizationContext authorization, HttpContext context)
    {
        var info = await authorization.GetAuthorizationInfo(context).ConfigureAwait(false);
        return info is { IsAuthenticated: true } && !info.UserId.Equals(Guid.Empty) ? info.UserId : null;
    }
}
