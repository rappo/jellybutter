using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Jellybutter.Presets;

/// <summary>
/// Keeps the <see cref="PresetVoteBook"/> in a JSON file beside the plugin's settings, outside the versioned
/// plugin folder an update replaces. Loaded on first use, written after every change (to a temporary file
/// first, so a crash mid-write never leaves half a file); one lock serializes all access.
/// </summary>
public sealed class PresetVoteStore
{
    /// <summary>
    /// The store's file name, in the plugin configurations folder.
    /// </summary>
    public const string FileName = "Jellyfin.Plugin.Jellybutter.votes.json";

    private static readonly JsonSerializerOptions _json = new() { WriteIndented = true };

    private readonly string _path;
    private readonly ILogger<PresetVoteStore> _logger;
    private readonly Lock _lock = new();
    private PresetVoteBook? _book;

    /// <summary>
    /// Initializes a new instance of the <see cref="PresetVoteStore"/> class.
    /// </summary>
    /// <param name="path">The JSON file.</param>
    /// <param name="logger">The logger.</param>
    public PresetVoteStore(string path, ILogger<PresetVoteStore> logger)
    {
        _path = path;
        _logger = logger;
    }

    /// <summary>
    /// Reads from the votes under the lock.
    /// </summary>
    /// <typeparam name="T">The result type.</typeparam>
    /// <param name="read">What to read.</param>
    /// <returns>Its result.</returns>
    public T Read<T>(Func<PresetVoteBook, T> read)
    {
        ArgumentNullException.ThrowIfNull(read);
        lock (_lock)
        {
            return read(Book());
        }
    }

    /// <summary>
    /// Changes the votes under the lock and saves them.
    /// </summary>
    /// <typeparam name="T">The result type.</typeparam>
    /// <param name="change">The change, returning whatever the caller needs from the changed book.</param>
    /// <returns>Its result.</returns>
    public T Update<T>(Func<PresetVoteBook, T> change)
    {
        ArgumentNullException.ThrowIfNull(change);
        lock (_lock)
        {
            var book = Book();
            var result = change(book);
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(book.Votes, _json));
            File.Move(temp, _path, overwrite: true);
            return result;
        }
    }

    private PresetVoteBook Book()
    {
        if (_book is not null)
        {
            return _book;
        }

        List<PresetVote>? stored = null;
        if (File.Exists(_path))
        {
            try
            {
                stored = JsonSerializer.Deserialize<List<PresetVote>>(File.ReadAllText(_path), _json);
            }
            catch (JsonException e)
            {
                // Kept aside rather than overwritten by the next vote, so nothing is lost silently.
                var aside = _path + ".unreadable-" + DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                File.Copy(_path, aside, overwrite: true);
                _logger.LogError(e, "Jellybutter: preset votes in {Path} are unreadable; starting empty, the file is kept as {Aside}.", _path, aside);
            }
        }

        _book = new PresetVoteBook(stored);
        return _book;
    }
}
