# The CI build: tests and publishes the plugin inside the .NET SDK image, so the shared runner needs no
# dotnet. `docker build --target artifact -o dist .` leaves the two files a release zip holds in dist/.
# node_modules must be in the build context (CI runs `npm ci` on the runner first): the SDK image has no
# node, and the csproj only falls back to npm when the Butterchurn bundles are missing.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY . .
RUN test -f node_modules/butterchurn/lib/butterchurn.min.js || (echo "run npm ci before docker build" && exit 1)
RUN dotnet restore
RUN dotnet test -c Release --no-restore
RUN dotnet publish Jellyfin.Plugin.Jellybutter -c Release --no-restore -o /out

FROM scratch AS artifact
COPY --from=build /out/Jellyfin.Plugin.Jellybutter.dll /
COPY --from=build /src/meta.json /
