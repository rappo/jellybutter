using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Milkdrop.Api;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Milkdrop.WebUi;

/// <summary>
/// Adds the client script to jellyfin-web's index.html as it is served. Jellyfin has no hook for a plugin to
/// extend the web client, and index.html on disk is root-owned in a container and replaced on every upgrade,
/// so the tag is added at request time instead: an <see cref="IStartupFilter"/> puts this middleware ahead of
/// the static-file handler, buffers only the index.html response, and rewrites it. Anything but a 200
/// text/html GET for index.html passes through untouched, the settings are read per request so a change
/// needs no restart, and an error while rewriting serves the original page.
/// </summary>
public sealed class ScriptInjection : IStartupFilter
{
    private readonly ILogger<ScriptInjection> _logger;
    private readonly Func<ClientSettings?> _settings;
    private int _announced;
    private int _warnedNoBody;

    /// <summary>
    /// Initializes a new instance of the <see cref="ScriptInjection"/> class.
    /// </summary>
    /// <param name="logger">The logger.</param>
    public ScriptInjection(ILogger<ScriptInjection> logger)
        : this(logger, () => ClientSettings.FromConfiguration(Plugin.Instance?.Configuration))
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="ScriptInjection"/> class with explicit settings. Test
    /// seam: the settings otherwise come from the plugin configuration, which a test has no instance of.
    /// </summary>
    /// <param name="logger">The logger.</param>
    /// <param name="settings">Reports the settings to inject, read per request, or <see langword="null"/> while the plugin is switched off.</param>
    internal ScriptInjection(ILogger<ScriptInjection> logger, Func<ClientSettings?> settings)
    {
        _logger = logger;
        _settings = settings;
    }

    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        ArgumentNullException.ThrowIfNull(next);

        return app =>
        {
            // Outermost, ahead of the host's pipeline, so the request can be normalized (no compression, no
            // ranges) before the static-file handler sees it and the plain response can be rewritten.
            app.Use(InvokeAsync);
            next(app);
        };
    }

    /// <summary>
    /// Determines whether a request path is the web client's index.html, however it is addressed: an explicit
    /// <c>/web/index.html</c>, or the <c>/web</c> and <c>/web/</c> shell routes. Suffix-matched so a base URL
    /// prefix (<c>/jellyfin/web/</c>) still matches.
    /// </summary>
    /// <param name="path">The request path.</param>
    /// <returns><see langword="true"/> for index.html.</returns>
    public static bool IsIndexRequest(string? path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return false;
        }

        return path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Serves index.html with the client script added, or passes the request through untouched.
    /// </summary>
    /// <param name="context">The request.</param>
    /// <param name="next">The rest of the pipeline.</param>
    /// <returns>A task that completes when the response is written.</returns>
    internal async Task InvokeAsync(HttpContext context, Func<Task> next)
    {
        if (!HttpMethods.IsGet(context.Request.Method) || !IsIndexRequest(context.Request.Path.Value))
        {
            await next().ConfigureAwait(false);
            return;
        }

        var settings = _settings();
        if (settings is null)
        {
            await next().ConfigureAwait(false);
            return;
        }

        // Ask for the plain, complete document: no compression to undo, and no 206 that would pass through
        // un-rewritten with a total length that no longer matches.
        context.Request.Headers.Remove(HeaderNames.AcceptEncoding);
        context.Request.Headers.Remove(HeaderNames.Range);
        context.Request.Headers.Remove(HeaderNames.IfRange);

        // The client's validators name the rewritten document, which the host has never seen, so they are
        // held back from it: it would compare them with the file's own and could answer 304 for a copy that
        // predates the last plugin update or settings change. The answer is decided below against the
        // document that is served.
        var requestHeaders = context.Request.GetTypedHeaders();
        var ifNoneMatch = requestHeaders.IfNoneMatch;
        var ifModifiedSince = requestHeaders.IfModifiedSince;
        context.Request.Headers.Remove(HeaderNames.IfNoneMatch);
        context.Request.Headers.Remove(HeaderNames.IfModifiedSince);

        var original = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await next().ConfigureAwait(false);
        }
        catch
        {
            // Nothing has reached the client yet; let the host's error handling answer rather than flushing
            // a truncated 200.
            context.Response.Body = original;
            throw;
        }

        context.Response.Body = original;
        buffer.Seek(0, SeekOrigin.Begin);

        var isHtml = context.Response.StatusCode == StatusCodes.Status200OK
            && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);
        if (!isHtml)
        {
            await buffer.CopyToAsync(original, context.RequestAborted).ConfigureAwait(false);
            return;
        }

        string html;
        using (var reader = new StreamReader(buffer, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 1024, leaveOpen: true))
        {
            html = await reader.ReadToEndAsync(context.RequestAborted).ConfigureAwait(false);
        }

        try
        {
            var injected = IndexHtmlInjector.Inject(html, Plugin.VersionString, settings);
            if (!ReferenceEquals(injected, html) && Interlocked.Exchange(ref _announced, 1) == 0)
            {
                _logger.LogInformation("Milkdrop: client script added to index.html at request time.");
            }
            else if (ReferenceEquals(injected, html) && !IndexHtmlInjector.HasScript(html) && Interlocked.Exchange(ref _warnedNoBody, 1) == 0)
            {
                // Nothing to insert before: a theme or proxy has reshaped the page. Without this the button
                // would just never appear, with no trace of why.
                _logger.LogWarning("Milkdrop: index.html has no closing body tag, so the client script was not added and the visualizer will not appear.");
            }

            html = injected;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Milkdrop: could not add the client script to index.html; serving it unchanged.");
        }

        var bytes = Encoding.UTF8.GetBytes(html);

        // The host's validators describe its file, not this document. The tag is the served bytes' own hash,
        // so it moves when the file, the injected tag, its version or its settings do. The date is the later
        // of the file's and this plugin's, the two things that can change what is served.
        var etag = new EntityTagHeaderValue("\"" + Convert.ToHexStringLower(SHA256.HashData(bytes)) + "\"");
        var responseHeaders = context.Response.GetTypedHeaders();
        var lastModified = Latest(responseHeaders.LastModified, EmbeddedAsset.WriteTime(typeof(ScriptInjection).Assembly));
        responseHeaders.ETag = etag;
        responseHeaders.LastModified = lastModified;
        context.Response.Headers.Remove(HeaderNames.AcceptRanges);
        if (!context.Response.Headers.ContainsKey(HeaderNames.CacheControl))
        {
            responseHeaders.CacheControl = new CacheControlHeaderValue { NoCache = true };
        }

        if (ConditionalGet.IsCurrent(ifNoneMatch, ifModifiedSince, etag, lastModified))
        {
            context.Response.StatusCode = StatusCodes.Status304NotModified;
            context.Response.ContentLength = null;
            context.Response.Headers.Remove(HeaderNames.ContentType);
            return;
        }

        context.Response.ContentType = "text/html; charset=utf-8";
        context.Response.ContentLength = bytes.Length;
        await original.WriteAsync(bytes, context.RequestAborted).ConfigureAwait(false);
    }

    private static DateTimeOffset? Latest(DateTimeOffset? a, DateTimeOffset? b)
        => a is null ? b : b is null ? a : (a > b ? a : b);
}
