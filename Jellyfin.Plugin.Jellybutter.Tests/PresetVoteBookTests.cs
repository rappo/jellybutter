using System;
using Jellyfin.Plugin.Jellybutter.Presets;
using Xunit;

namespace Jellyfin.Plugin.Jellybutter.Tests;

public class PresetVoteBookTests
{
    private static readonly Guid _ann = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid _bob = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly DateTimeOffset _t0 = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Shared_TheLatestVoteOnAPresetWins_WhoeverCastIt()
    {
        var book = new PresetVoteBook();
        book.Cast("Geiss - Swirl", _ann, PresetVoteBook.Block, _t0);
        book.Cast("Geiss - Swirl", _bob, PresetVoteBook.Like, _t0.AddMinutes(1));
        book.Cast("Flexi - Mash", _bob, PresetVoteBook.Like, _t0);

        var shared = book.For(_ann, perUser: false);

        Assert.Equal(["Flexi - Mash", "Geiss - Swirl"], shared.Likes);
        Assert.Empty(shared.Blocks);
    }

    [Fact]
    public void PerUser_EachUserGoesByTheirOwnVotes_IncludingOnesCastWhileShared()
    {
        var book = new PresetVoteBook();
        book.Cast("Geiss - Swirl", _ann, PresetVoteBook.Block, _t0);
        book.Cast("Geiss - Swirl", _bob, PresetVoteBook.Like, _t0.AddMinutes(1));

        Assert.Equal(["Geiss - Swirl"], book.For(_ann, perUser: true).Blocks);
        Assert.Empty(book.For(_ann, perUser: true).Likes);
        Assert.Equal(["Geiss - Swirl"], book.For(_bob, perUser: true).Likes);
    }

    [Fact]
    public void ClearingAVote_IsTheLatestWordToo()
    {
        var book = new PresetVoteBook();
        book.Cast("Geiss - Swirl", _ann, PresetVoteBook.Like, _t0);
        book.Cast("Geiss - Swirl", _bob, null, _t0.AddMinutes(1));

        Assert.Empty(book.For(_ann, perUser: false).Likes);       // Bob's "neither" is newest
        Assert.Equal(["Geiss - Swirl"], book.For(_ann, perUser: true).Likes);
    }

    [Fact]
    public void AUsersNewVote_ReplacesTheirOldOne()
    {
        var book = new PresetVoteBook();
        book.Cast("Geiss - Swirl", _ann, PresetVoteBook.Like, _t0);
        book.Cast("Geiss - Swirl", _ann, PresetVoteBook.Block, _t0.AddMinutes(1));

        Assert.Single(book.Votes);
        Assert.Equal(["Geiss - Swirl"], book.For(_ann, perUser: true).Blocks);
    }

    [Fact]
    public void Clear_ForgetsOnePresetOrEverything_FromEveryUser()
    {
        var book = new PresetVoteBook();
        book.Cast("a", _ann, PresetVoteBook.Like, _t0);
        book.Cast("a", _bob, PresetVoteBook.Like, _t0);
        book.Cast("b", _bob, PresetVoteBook.Block, _t0);

        Assert.Equal(2, book.Clear("a"));
        Assert.Equal(["b"], book.For(_bob, perUser: false).Blocks);
        Assert.Equal(1, book.Clear(null));
        Assert.Empty(book.Votes);
    }

    [Fact]
    public void StoredVotes_AreNormalized_AndBadOnesDropped_KeepingTheLatestPerUserAndPreset()
    {
        var book = new PresetVoteBook(
        [
            new PresetVote("a", _ann, "LIKE", _t0.AddMinutes(1)),
            new PresetVote("a", _ann, "block", _t0),               // older: loses to the like above
            new PresetVote("b", _ann, "meh", _t0),                 // not a vote
            new PresetVote(" ", _ann, "like", _t0)                 // not a preset
        ]);

        Assert.Equal(["a"], book.For(_ann, perUser: true).Likes);
        Assert.Single(book.Votes);
    }

    [Theory]
    [InlineData("like", "like")]
    [InlineData(" Block ", "block")]
    [InlineData("none", null)]
    [InlineData("love", null)]
    [InlineData(null, null)]
    public void NormalizeVote_KnowsLikeAndBlock(string? sent, string? expected)
        => Assert.Equal(expected, PresetVoteBook.NormalizeVote(sent));
}
