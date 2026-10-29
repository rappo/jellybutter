using Jellyfin.Plugin.Jellybutter.WebUi;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Jellybutter;

/// <summary>
/// Registers the plugin's services into the host DI container. The one service is the startup filter that
/// adds the client script to index.html; the asset endpoints are an ordinary API controller the host finds
/// by scanning the plugin assembly.
/// </summary>
public sealed class ServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<IStartupFilter, ScriptInjection>();
    }
}
