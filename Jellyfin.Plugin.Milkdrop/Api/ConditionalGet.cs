using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Milkdrop.Api;

/// <summary>
/// Decides whether a browser's cached copy of a response is still current, so index.html can be answered
/// with a 304 instead of being rewritten and sent again.
/// </summary>
internal static class ConditionalGet
{
    /// <summary>
    /// Decides whether a client's copy is still current. <c>If-None-Match</c> wins over <c>If-Modified-Since</c>
    /// when both are present (RFC 9110 section 13.1.3), and a date is only ever compared when there is no tag.
    /// </summary>
    /// <param name="ifNoneMatch">The request's <c>If-None-Match</c> tags.</param>
    /// <param name="ifModifiedSince">The request's <c>If-Modified-Since</c>, if any.</param>
    /// <param name="etag">The current tag.</param>
    /// <param name="lastModified">When the content last changed, at HTTP-date resolution (see <see cref="ToHttpDate"/>), or <see langword="null"/> when unknown.</param>
    /// <returns><see langword="true"/> when the client's copy matches.</returns>
    public static bool IsCurrent(IList<EntityTagHeaderValue> ifNoneMatch, DateTimeOffset? ifModifiedSince, EntityTagHeaderValue etag, DateTimeOffset? lastModified)
    {
        ArgumentNullException.ThrowIfNull(ifNoneMatch);
        ArgumentNullException.ThrowIfNull(etag);

        if (ifNoneMatch.Count > 0)
        {
            return ifNoneMatch.Any(t => t.Equals(EntityTagHeaderValue.Any) || t.Compare(etag, useStrongComparison: false));
        }

        return lastModified is { } modified && ifModifiedSince is { } since && modified <= since;
    }

    /// <summary>
    /// Truncates a time to whole seconds, which is all an HTTP date carries. Compared at that resolution, a
    /// copy that is current would otherwise look older than the server's sub-second timestamp.
    /// </summary>
    /// <param name="time">The time.</param>
    /// <returns>The time without its sub-second part.</returns>
    public static DateTimeOffset ToHttpDate(DateTimeOffset time) => time.AddTicks(-(time.UtcTicks % TimeSpan.TicksPerSecond));
}
