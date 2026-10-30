using System;
using System.IO;
using System.Threading.Tasks;
using Jellyfin.Plugin.Jellybutter.Api;
using Jellyfin.Plugin.Jellybutter.Configuration;
using Jellyfin.Plugin.Jellybutter.Presets;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.Jellybutter.Tests;

// The vote endpoints against a real store in a temporary folder: votes are stamped with the caller, survive a
// reload from the file, and the per-user setting is applied when reading.
public sealed class PresetVotesControllerTests : IDisposable
{
    private static readonly Guid _ann = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid _bob = Guid.Parse("22222222-2222-2222-2222-222222222222");

    private readonly string _dir = Directory.CreateTempSubdirectory("jellybutter-votes-").FullName;
    private readonly PluginConfiguration _config = new();
    private DateTimeOffset _now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    public void Dispose() => Directory.Delete(_dir, true);

    private string StorePath => Path.Combine(_dir, PresetVoteStore.FileName);

    private PresetVoteStore NewStore() => new(StorePath, NullLogger<PresetVoteStore>.Instance);

    private PresetVotesController Controller(PresetVoteStore store, Guid user)
    {
        _now = _now.AddSeconds(1);
        var now = _now;
        Guid? caller = user.Equals(Guid.Empty) ? null : user;
        return new PresetVotesController(store, _ => Task.FromResult(caller), () => _config, () => now)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };
    }

    [Fact]
    public async Task AVote_IsStoredWithItsUser_AndOutlivesTheProcess()
    {
        var store = NewStore();
        var after = (await Controller(store, _ann).Vote(new PresetVoteRequest("Geiss - Swirl", "like"))).Value!;
        Assert.Equal(["Geiss - Swirl"], after.Likes);

        var reloaded = NewStore();
        var vote = Assert.Single(reloaded.Read(book => book.Votes));
        Assert.Equal(_ann, vote.UserId);
        Assert.Equal("like", vote.Vote);
    }

    [Fact]
    public async Task TheSharedList_ByDefault_AndPerUserWhenSwitched()
    {
        var store = NewStore();
        await Controller(store, _ann).Vote(new PresetVoteRequest("Geiss - Swirl", "block"));
        await Controller(store, _bob).Vote(new PresetVoteRequest("Flexi - Mash", "like"));

        var shared = (await Controller(store, _ann).GetVotes()).Value!;
        Assert.Equal(["Flexi - Mash"], shared.Likes);
        Assert.Equal(["Geiss - Swirl"], shared.Blocks);

        _config.VotesPerUser = true;
        var own = (await Controller(store, _ann).GetVotes()).Value!;
        Assert.Empty(own.Likes);
        Assert.Equal(["Geiss - Swirl"], own.Blocks);
    }

    [Fact]
    public async Task None_ClearsTheCallersVote()
    {
        var store = NewStore();
        await Controller(store, _ann).Vote(new PresetVoteRequest("Geiss - Swirl", "like"));
        var after = (await Controller(store, _ann).Vote(new PresetVoteRequest("Geiss - Swirl", "none"))).Value!;

        Assert.Empty(after.Likes);
    }

    [Theory]
    [InlineData("Geiss - Swirl", "love")]
    [InlineData("Geiss - Swirl", null)]
    [InlineData("", "like")]
    [InlineData(null, "like")]
    public async Task ABadVote_Is400_AndStoresNothing(string? preset, string? vote)
    {
        var store = NewStore();
        var result = await Controller(store, _ann).Vote(new PresetVoteRequest(preset, vote));

        Assert.IsType<BadRequestResult>(result.Result);
        Assert.False(File.Exists(StorePath));
    }

    [Fact]
    public async Task WithoutAUser_OrSwitchedOff_It404s()
    {
        var store = NewStore();
        Assert.IsType<NotFoundResult>((await Controller(store, Guid.Empty).GetVotes()).Result);

        _config.Enabled = false;
        Assert.IsType<NotFoundResult>((await Controller(store, _ann).Vote(new PresetVoteRequest("a", "like"))).Result);
    }

    [Fact]
    public async Task AnUnreadableFile_IsKeptAside_AndVotingStartsOver()
    {
        await File.WriteAllTextAsync(StorePath, "{ not json");
        var store = NewStore();

        var after = (await Controller(store, _ann).Vote(new PresetVoteRequest("a", "block"))).Value!;

        Assert.Equal(["a"], after.Blocks);
        Assert.Single(Directory.GetFiles(_dir, PresetVoteStore.FileName + ".unreadable-*"));
    }

    [Fact]
    public async Task AdminClear_ForgetsOnePreset()
    {
        var store = NewStore();
        await Controller(store, _ann).Vote(new PresetVoteRequest("a", "like"));
        await Controller(store, _bob).Vote(new PresetVoteRequest("b", "like"));

        Assert.IsType<NoContentResult>(Controller(store, _ann).ClearVotes("a"));
        var all = Assert.IsType<OkObjectResult>(Controller(store, _ann).GetAllVotes().Result);
        var vote = Assert.Single((System.Collections.Generic.IReadOnlyList<PresetVote>)all.Value!);
        Assert.Equal("b", vote.Preset);
    }
}
