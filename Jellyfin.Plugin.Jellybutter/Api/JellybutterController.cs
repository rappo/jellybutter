using System;
using System.Collections.Generic;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Jellybutter.Api;

/// <summary>
/// Serves the plugin's client-side files: the client script the injected tag loads, and the Butterchurn
/// engine and preset packs the script fetches the first time the visualizer opens. All anonymous, since index.html loads
/// the script before sign-in and none of them carries data. Every URL is addressed with the plugin version
/// as a query; a request that names the current version is answered as immutable for a year, so a returning
/// browser never asks again until an update changes the tag, and any other request revalidates each time.
/// </summary>
[ApiController]
[Route("Jellybutter")]
public class JellybutterController : ControllerBase
{
    /// <summary>
    /// The route of the client script, relative to the server root, as the injected script tag references it.
    /// </summary>
    public const string ClientScriptPath = "Jellybutter/client.js";

    private const string ResourcePrefix = "Jellyfin.Plugin.Jellybutter.Web.";
    private const string JavaScript = "application/javascript";

    private static readonly Lazy<EmbeddedAsset?> _clientScript = new(() => Load("jellybutter.js"));
    private static readonly Lazy<EmbeddedAsset?> _butterchurn = new(() => Load("butterchurn.min.js"));
    private static readonly Lazy<EmbeddedAsset?> _presets = new(() => Load("butterchurnPresets.min.js"));

    // The optional packs by the name the settings and the client use for them.
    private static readonly Dictionary<string, Lazy<EmbeddedAsset?>> _packs = new(StringComparer.Ordinal)
    {
        ["extra"] = new(() => Load("butterchurnPresetsExtra.min.js")),
        ["extra2"] = new(() => Load("butterchurnPresetsExtra2.min.js")),
        ["md1"] = new(() => Load("butterchurnPresetsMD1.min.js"))
    };

    private readonly Func<bool> _enabled;

    /// <summary>
    /// Initializes a new instance of the <see cref="JellybutterController"/> class.
    /// </summary>
    public JellybutterController()
        : this(() => Plugin.Instance?.Configuration?.Enabled ?? false)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="JellybutterController"/> class with an explicit switch.
    /// Test seam: the switch otherwise comes from the plugin configuration, which a test has no instance of.
    /// </summary>
    /// <param name="enabled">Reports whether the plugin is switched on, read per request.</param>
    internal JellybutterController(Func<bool> enabled)
    {
        _enabled = enabled;
    }

    /// <summary>
    /// Serves the client script.
    /// </summary>
    /// <param name="v">The plugin version the caller expects, from the script tag's cache buster.</param>
    /// <returns>The script, or 404 while the plugin is switched off.</returns>
    [HttpGet("client.js")]
    [AllowAnonymous]
    [Produces(JavaScript)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetClientScript([FromQuery] string? v) => Serve(_clientScript.Value, v);

    /// <summary>
    /// Serves the Butterchurn engine bundle.
    /// </summary>
    /// <param name="v">The plugin version the caller expects.</param>
    /// <returns>The bundle, or 404 while the plugin is switched off.</returns>
    [HttpGet("butterchurn.js")]
    [AllowAnonymous]
    [Produces(JavaScript)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetButterchurn([FromQuery] string? v) => Serve(_butterchurn.Value, v);

    /// <summary>
    /// Serves the Butterchurn presets bundle.
    /// </summary>
    /// <param name="v">The plugin version the caller expects.</param>
    /// <returns>The bundle, or 404 while the plugin is switched off.</returns>
    [HttpGet("butterchurn-presets.js")]
    [AllowAnonymous]
    [Produces(JavaScript)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetPresets([FromQuery] string? v) => Serve(_presets.Value, v);

    /// <summary>
    /// Serves one of the optional preset packs.
    /// </summary>
    /// <param name="pack">The pack: extra, extra2 or md1.</param>
    /// <param name="v">The plugin version the caller expects.</param>
    /// <returns>The pack, or 404 for an unknown pack or while the plugin is switched off.</returns>
    [HttpGet("butterchurn-presets-{pack}.js")]
    [AllowAnonymous]
    [Produces(JavaScript)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetPresetPack([FromRoute] string pack, [FromQuery] string? v)
        => Serve(_packs.TryGetValue(pack, out var asset) ? asset.Value : null, v);

    /// <summary>
    /// Picks the cache directive for a request: immutable for a year when it names the current plugin
    /// version (the URL changes with every update, so the copy can never go stale), revalidate-every-time
    /// otherwise (a hand-typed URL, or a tag from a page cached across an update).
    /// </summary>
    /// <param name="requestedVersion">The version query, if any.</param>
    /// <param name="currentVersion">The running plugin's version.</param>
    /// <returns>The <c>Cache-Control</c> value.</returns>
    internal static string CacheControlFor(string? requestedVersion, string currentVersion)
        => string.Equals(requestedVersion, currentVersion, StringComparison.Ordinal)
            ? "public, max-age=31536000, immutable"
            : "public, no-cache";

    private static EmbeddedAsset? Load(string name)
        => EmbeddedAsset.Load(typeof(JellybutterController).Assembly, ResourcePrefix + name, JavaScript);

    private IActionResult Serve(EmbeddedAsset? asset, string? requestedVersion)
    {
        if (!_enabled() || asset is null)
        {
            return NotFound();
        }

        Response.Headers[HeaderNames.CacheControl] = CacheControlFor(requestedVersion, Plugin.VersionString);
        return File(asset.Bytes, asset.ContentType, asset.LastModified, asset.ETag);
    }
}
