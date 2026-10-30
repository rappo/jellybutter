using System.IO;
using Jellyfin.Plugin.Jellybutter.Presets;
using Jellyfin.Plugin.Jellybutter.WebUi;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Jellybutter;

/// <summary>
/// Registers the plugin's services into the host DI container: the startup filter that adds the client script
/// to index.html, and the preset vote store (beside the plugin's settings file, which outlives updates). The
/// endpoints are ordinary API controllers the host finds by scanning the plugin assembly.
/// </summary>
public sealed class ServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<IStartupFilter, ScriptInjection>();
        serviceCollection.AddSingleton(services => new PresetVoteStore(
            Path.Combine(services.GetRequiredService<IApplicationPaths>().PluginConfigurationsPath, PresetVoteStore.FileName),
            services.GetRequiredService<ILogger<PresetVoteStore>>()));
    }
}
