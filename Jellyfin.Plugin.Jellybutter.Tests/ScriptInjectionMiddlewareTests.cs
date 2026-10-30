using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Plugin.Jellybutter.WebUi;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Net.Http.Headers;
using Xunit;

namespace Jellyfin.Plugin.Jellybutter.Tests;

// The middleware serves index.html with the client script added and gives that rewritten document validators
// of its own. The host's static-file handler stands behind it, so each test plays that handler with a fake next.
public class ScriptInjectionMiddlewareTests
{
    private const string HostHtml = "<html><body><h1>jellyfin</h1></body></html>";
    private static readonly DateTimeOffset _hostModified = new(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);
    private static readonly ClientSettings _settings = new(true, 30, 2.7, true, true, true, "visualizer", "medium", true, 2, true, "seconds", 1);

    private static ScriptInjection Middleware(bool enabled = true)
        => new(NullLogger<ScriptInjection>.Instance, () => enabled ? _settings : null);

    private static DefaultHttpContext Request(string path = "/web/index.html", string? ifNoneMatch = null, DateTimeOffset? ifModifiedSince = null)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = "GET";
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        if (ifNoneMatch is not null)
        {
            context.Request.Headers[HeaderNames.IfNoneMatch] = ifNoneMatch;
        }

        if (ifModifiedSince is { } since)
        {
            context.Request.GetTypedHeaders().IfModifiedSince = since;
        }

        return context;
    }

    private static async Task Host(HttpContext context, string html = HostHtml, int status = StatusCodes.Status200OK, string contentType = "text/html")
    {
        context.Response.StatusCode = status;
        context.Response.ContentType = contentType;
        context.Response.Headers[HeaderNames.ETag] = "\"host-tag\"";
        context.Response.Headers[HeaderNames.CacheControl] = "no-cache";
        context.Response.GetTypedHeaders().LastModified = _hostModified;
        await context.Response.Body.WriteAsync(Encoding.UTF8.GetBytes(html));
    }

    private static async Task<DefaultHttpContext> Serve(DefaultHttpContext context, string html = HostHtml, bool enabled = true)
    {
        await Middleware(enabled).InvokeAsync(context, () => Host(context, html));
        return context;
    }

    private static string Body(HttpContext context) => Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray());

    private static string TagOf(HttpContext context) => context.Response.GetTypedHeaders().ETag!.ToString();

    [Fact]
    public async Task ServesTheDocumentWithTheScriptAndItsOwnValidators()
    {
        var context = await Serve(Request());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Contains(IndexHtmlInjector.Marker, Body(context), StringComparison.Ordinal);
        Assert.Contains("Jellybutter/client.js?v=", Body(context), StringComparison.Ordinal);

        var bytes = Encoding.UTF8.GetBytes(Body(context));
        Assert.Equal("\"" + Convert.ToHexStringLower(SHA256.HashData(bytes)) + "\"", TagOf(context));
        Assert.Equal(bytes.Length, context.Response.ContentLength);
        Assert.True(context.Response.GetTypedHeaders().LastModified >= _hostModified);
        Assert.True(context.Response.GetTypedHeaders().CacheControl!.NoCache);
    }

    [Fact]
    public async Task AReturningClientWithTheCurrentTag_GetsA304WithNoBody()
    {
        var first = await Serve(Request());

        var second = await Serve(Request(ifNoneMatch: TagOf(first)));

        Assert.Equal(StatusCodes.Status304NotModified, second.Response.StatusCode);
        Assert.Empty(Body(second));
        Assert.Null(second.Response.ContentLength);
        Assert.Equal(TagOf(first), TagOf(second));
    }

    [Fact]
    public async Task WhenTheSettingsChange_TheTagChanges_SoACachedPageIsReplaced()
    {
        var before = await Serve(Request());
        var context = Request(ifNoneMatch: TagOf(before));

        await new ScriptInjection(NullLogger<ScriptInjection>.Instance, () => new ClientSettings(false, 30, 2.7, true, true, true, "visualizer", "medium", true, 2, true, "seconds", 1)).InvokeAsync(context, () => Host(context));

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.NotEqual(TagOf(before), TagOf(context));
        Assert.Contains("desktopWebAudio&quot;:false", Body(context), StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheClientsValidatorsAreNotHandedToTheHost()
    {
        var context = Request(ifNoneMatch: "\"anything\"", ifModifiedSince: new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var sawTag = true;
        var sawDate = true;

        await Middleware().InvokeAsync(context, () =>
        {
            sawTag = context.Request.Headers.ContainsKey(HeaderNames.IfNoneMatch);
            sawDate = context.Request.Headers.ContainsKey(HeaderNames.IfModifiedSince);
            return Host(context);
        });

        Assert.False(sawTag);
        Assert.False(sawDate);
    }

    [Fact]
    public async Task WhenSwitchedOff_TheHostsResponseIsUntouched_WithTheHostsValidators()
    {
        var context = Request(ifNoneMatch: "\"host-tag\"");
        var sawTag = false;

        await Middleware(enabled: false).InvokeAsync(context, () =>
        {
            sawTag = context.Request.Headers.ContainsKey(HeaderNames.IfNoneMatch);
            return Host(context);
        });

        Assert.True(sawTag);
        Assert.Equal(HostHtml, Body(context));
        Assert.Equal("\"host-tag\"", TagOf(context));
    }

    [Theory]
    [InlineData(StatusCodes.Status404NotFound, "text/html")]
    [InlineData(StatusCodes.Status200OK, "application/json")]
    public async Task ANonHtmlOrNon200Response_PassesThroughWithTheHostsHeaders(int status, string contentType)
    {
        var context = Request();

        await Middleware().InvokeAsync(context, () => Host(context, "not the page", status, contentType));

        Assert.Equal(status, context.Response.StatusCode);
        Assert.Equal("not the page", Body(context));
        Assert.Equal("\"host-tag\"", TagOf(context));
    }

    [Fact]
    public async Task ARequestForSomethingElse_IsNotTouched()
    {
        var context = Request(path: "/web/main.jellyfin.bundle.js", ifNoneMatch: "\"host-tag\"");
        var sawTag = false;

        await Middleware().InvokeAsync(context, () =>
        {
            sawTag = context.Request.Headers.ContainsKey(HeaderNames.IfNoneMatch);
            return Host(context, "console.log(1)", contentType: "application/javascript");
        });

        Assert.True(sawTag);
        Assert.Equal("console.log(1)", Body(context));
    }

    [Fact]
    public async Task APostIsNotTouched()
    {
        var context = Request();
        context.Request.Method = "POST";

        await Serve(context);

        Assert.Equal(HostHtml, Body(context));
    }

    [Fact]
    public async Task WithNoClosingBodyTag_TheOperatorIsToldOnce_AndThePageIsServedUnchanged()
    {
        const string noBody = "<html><body><h1>jellyfin</h1>";
        var logger = new ListLogger();
        var middleware = new ScriptInjection(logger, () => _settings);

        for (var i = 0; i < 2; i++)
        {
            var context = Request();
            await middleware.InvokeAsync(context, () => Host(context, noBody));

            Assert.Equal(noBody, Body(context));
        }

        var warning = Assert.Single(logger.Entries, e => e.Level == LogLevel.Warning);
        Assert.Contains("closing body tag", warning.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ASuccessfulInjection_IsAnnouncedOnce()
    {
        var logger = new ListLogger();
        var middleware = new ScriptInjection(logger, () => _settings);

        for (var i = 0; i < 2; i++)
        {
            var context = Request();
            await middleware.InvokeAsync(context, () => Host(context));
        }

        Assert.Single(logger.Entries, e => e.Level == LogLevel.Information);
        Assert.DoesNotContain(logger.Entries, e => e.Level == LogLevel.Warning);
    }

    private sealed class ListLogger : ILogger<ScriptInjection>
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => Entries.Add((logLevel, formatter(state, exception)));
    }
}
