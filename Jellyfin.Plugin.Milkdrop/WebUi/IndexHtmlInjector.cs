using System;
using System.Globalization;
using System.Net;
using Jellyfin.Plugin.Milkdrop.Api;

namespace Jellyfin.Plugin.Milkdrop.WebUi;

/// <summary>
/// The pure half of script injection: adds the client script tag to a jellyfin-web index.html.
/// </summary>
internal static class IndexHtmlInjector
{
    /// <summary>
    /// The attribute that marks the tag, so a second pass (or a tag pasted into a custom index.html by hand)
    /// is recognized and nothing doubles up.
    /// </summary>
    public const string Marker = "data-jf-milkdrop";

    /// <summary>
    /// The attribute that carries the settings JSON.
    /// </summary>
    public const string ConfigAttribute = "data-config";

    /// <summary>
    /// Builds the script tag. The src is relative to index.html's own folder (<c>/web/</c>), so it resolves
    /// under a base URL prefix too; the version query defeats a stale cached copy after a plugin update. The
    /// tag is not deferred: it must run before jellyfin-web's deferred bundles so the Jellyfin Desktop
    /// player-list wrap is in place before the web client asks the shell for its plugins.
    /// </summary>
    /// <param name="version">The plugin version.</param>
    /// <param name="settings">The settings the script runs with.</param>
    /// <returns>The tag.</returns>
    public static string ScriptTag(string version, ClientSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);

        return string.Create(
            CultureInfo.InvariantCulture,
            $"<script {Marker} {ConfigAttribute}=\"{WebUtility.HtmlEncode(settings.ToJson())}\" src=\"../{MilkdropController.ClientScriptPath}?v={Uri.EscapeDataString(version)}\"></script>");
    }

    /// <summary>
    /// Determines whether a document already carries the script tag.
    /// </summary>
    /// <param name="html">The index.html contents.</param>
    /// <returns><see langword="true"/> when the tag is present.</returns>
    public static bool HasScript(string html)
    {
        ArgumentNullException.ThrowIfNull(html);

        return html.Contains(Marker, StringComparison.Ordinal);
    }

    /// <summary>
    /// Inserts the script tag before the closing body tag, once.
    /// </summary>
    /// <param name="html">The index.html contents.</param>
    /// <param name="version">The plugin version.</param>
    /// <param name="settings">The settings the script runs with.</param>
    /// <returns>The contents with the tag, or the same instance when it is already there or there is no body to add it to.</returns>
    public static string Inject(string html, string version, ClientSettings settings)
    {
        ArgumentNullException.ThrowIfNull(html);

        if (HasScript(html))
        {
            return html;
        }

        var bodyClose = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (bodyClose < 0)
        {
            return html;
        }

        return string.Concat(html.AsSpan(0, bodyClose), ScriptTag(version, settings), "\n", html.AsSpan(bodyClose));
    }
}
