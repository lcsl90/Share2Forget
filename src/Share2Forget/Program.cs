using Microsoft.AspNetCore.SignalR;
using Share2Forget;

var builder = WebApplication.CreateBuilder(args);

var maxFileMb = long.TryParse(builder.Configuration["MAX_FILE_MB"], out var mb) && mb > 0 ? mb : 1024;
var ttlHours = double.TryParse(builder.Configuration["CHANNEL_TTL_HOURS"], out var ttl) && ttl >= 0 ? ttl : 24;
var dataDir = builder.Configuration["DATA_DIR"] ?? Path.Combine(Path.GetTempPath(), "share2forget");

builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = maxFileMb * 1024 * 1024);
// Rich-Text-Nachrichten (Code-Blöcke etc.) können deutlich größer als die 32-KB-Voreinstellung sein.
builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 512 * 1024);
builder.Services.AddSingleton(new ChannelStore(dataDir));

var app = builder.Build();
var store = app.Services.GetRequiredService<ChannelStore>();

// Uploaded files are served with a restricted content-type whitelist; keep browsers from sniffing.
app.Use(async (context, next) =>
{
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();
app.MapHub<ChannelHub>("/hub");

// Only these types are ever served inline; everything else is a forced download.
var inlineTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
{
    [".png"] = "image/png",
    [".jpg"] = "image/jpeg",
    [".jpeg"] = "image/jpeg",
    [".gif"] = "image/gif",
    [".webp"] = "image/webp",
    [".avif"] = "image/avif",
    [".bmp"] = "image/bmp",
    [".pdf"] = "application/pdf",
    [".mp4"] = "video/mp4",
    [".webm"] = "video/webm",
    [".txt"] = "text/plain; charset=utf-8",
    [".md"] = "text/plain; charset=utf-8",
    [".log"] = "text/plain; charset=utf-8",
};

app.MapGet("/api/channels", () => Results.Json(
    store.All()
        .OrderByDescending(c => c.CreatedAt)
        .Select(c => new ChannelInfo(c.Code, c.HasPassword, c.Connected, c.Messages.Count, c.CreatedAt))
        .ToList()));

app.MapPost("/api/channels", (CreateRequest request) =>
{
    var channel = store.Create(string.IsNullOrEmpty(request.Password) ? null : request.Password);
    return Results.Json(new { code = channel.Code, token = channel.Token, hasPassword = channel.HasPassword });
});

app.MapPost("/api/channels/{code}/join", (string code, JoinRequest request) =>
{
    var channel = store.Get(code);
    if (channel is null)
        return Results.NotFound(new { error = $"Hier ist niemand – den Channel \"{code}\" gibt es nicht." });

    if (!store.VerifyPassword(channel, request.Password))
        return Results.Json(new
        {
            error = string.IsNullOrEmpty(request.Password)
                ? $"Der Channel \"{code}\" ist passwortgeschützt."
                : "Falsches Passwort.",
            passwordRequired = true,
        }, statusCode: StatusCodes.Status401Unauthorized);

    return Results.Json(new { code = channel.Code, token = channel.Token, hasPassword = channel.HasPassword });
});

// POST instead of DELETE so the optional password can travel in a JSON body.
app.MapPost("/api/channels/{code}/delete", async (string code, DeleteRequest request, IHubContext<ChannelHub> hub) =>
{
    var channel = store.Get(code);
    if (channel is null)
        return Results.NotFound(new { error = $"Den Channel \"{code}\" gibt es nicht." });

    var authorized = (!string.IsNullOrEmpty(request.Token) && channel.Token == request.Token)
        || store.VerifyPassword(channel, request.Password);
    if (!authorized)
        return Results.Json(new
        {
            error = "Zum Löschen wird das Passwort des Channels benötigt.",
            passwordRequired = true,
        }, statusCode: StatusCodes.Status401Unauthorized);

    store.Delete(code);
    await hub.Clients.Group(code).SendAsync("channelDeleted", code);
    return Results.Json(new { ok = true });
});

// Raw body upload: PUT the file bytes, metadata in the query string. No multipart needed.
app.MapPut("/api/channels/{code}/files", async (string code, HttpRequest request, IHubContext<ChannelHub> hub, CancellationToken ct) =>
{
    var channel = store.GetAuthorized(code, request.Query["t"].ToString());
    if (channel is null)
        return Results.NotFound(new { error = "Channel nicht gefunden oder Zugriff verweigert." });

    var name = Util.CleanFileName(request.Query["name"].ToString());
    var sender = Util.CleanName(request.Query["from"].ToString());
    var senderId = request.Query["sid"].ToString();

    var fileId = Guid.NewGuid().ToString("N");
    var path = store.NewFilePath(fileId);
    try
    {
        await using var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true);
        await request.Body.CopyToAsync(fs, ct);
    }
    catch (BadHttpRequestException)
    {
        try { File.Delete(path); } catch { }
        return Results.Json(new { error = $"Datei zu groß (max. {maxFileMb} MB) oder Übertragung abgebrochen." },
            statusCode: StatusCodes.Status413PayloadTooLarge);
    }
    catch
    {
        try { File.Delete(path); } catch { }
        throw;
    }

    if (!ReferenceEquals(store.Get(code), channel))
    {
        // Channel was deleted while the upload was running.
        try { File.Delete(path); } catch { }
        return Results.NotFound(new { error = "Diesen Channel gibt es nicht mehr." });
    }

    var size = new FileInfo(path).Length;
    channel.Files[fileId] = new FileEntry(fileId, name, size, path);
    var message = new ChatMessage(
        Guid.NewGuid().ToString("N"), "file", sender, senderId,
        DateTimeOffset.UtcNow, FileId: fileId, FileName: name, FileSize: size);
    store.AddMessage(channel, message);
    await hub.Clients.Group(code).SendAsync("message", code, message);
    return Results.Json(new { ok = true, fileId, size });
});

app.MapGet("/api/channels/{code}/files/{fileId}", (string code, string fileId, HttpRequest request) =>
{
    var channel = store.GetAuthorized(code, request.Query["t"].ToString());
    if (channel is null) return Results.NotFound();
    if (!channel.Files.TryGetValue(fileId, out var file) || !File.Exists(file.Path)) return Results.NotFound();

    var inline = inlineTypes.TryGetValue(Path.GetExtension(file.Name), out var contentType)
        && request.Query["dl"] != "1";
    return inline
        ? Results.File(file.Path, contentType, enableRangeProcessing: true)
        : Results.File(file.Path, "application/octet-stream", fileDownloadName: file.Name, enableRangeProcessing: true);
});

// Forget: sweep channels nobody is connected to after CHANNEL_TTL_HOURS of inactivity.
if (ttlHours > 0)
{
    _ = Task.Run(async () =>
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));
        try
        {
            while (await timer.WaitForNextTickAsync(app.Lifetime.ApplicationStopping))
            {
                var cutoff = DateTimeOffset.UtcNow.AddHours(-ttlHours);
                foreach (var channel in store.All())
                    if (channel.Connected <= 0 && channel.LastActivity < cutoff)
                        store.Delete(channel.Code);
            }
        }
        catch (OperationCanceledException) { }
    });
}

app.Run();

record ChannelInfo(string Code, bool HasPassword, int Users, int Messages, DateTimeOffset CreatedAt);
record CreateRequest(string? Password);
record JoinRequest(string? Password);
record DeleteRequest(string? Token, string? Password);
