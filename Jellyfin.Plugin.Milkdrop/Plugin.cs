using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.Milkdrop.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.Milkdrop;

/// <summary>
/// Adds a Butterchurn (MilkDrop 2) music visualizer to the Jellyfin web client.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">Instance of the <see cref="IApplicationPaths"/> interface.</param>
    /// <param name="xmlSerializer">Instance of the <see cref="IXmlSerializer"/> interface.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "Milkdrop Visualizer";

    /// <inheritdoc />
    public override string Description =>
        "A MilkDrop 2 music visualizer (Butterchurn) inside the Jellyfin web client and Jellyfin Desktop.";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("7efeb814-3e67-466d-a2a1-6842ef86a500");

    /// <summary>
    /// Gets the plugin version as the script tag and the asset endpoints name it: the assembly version,
    /// which Directory.Build.props reads from meta.json.
    /// </summary>
    public static string VersionString => typeof(Plugin).Assembly.GetName().Version?.ToString() ?? "0";

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = "MilkdropConfig",
            EmbeddedResourcePath = string.Format(CultureInfo.InvariantCulture, "{0}.Configuration.configPage.html", GetType().Namespace)
        };
    }
}
