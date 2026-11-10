using System.Text.Json;
using System.Text.RegularExpressions;
using Hongguo.Licensing;

var options = BrokerOptions.Parse(args);
var store = new PrivateLicenseStore(options.StateDirectory, options.DeviceId);
using var stop = new CancellationTokenSource();
var rpc = new BrokerRpc(stop, options.MaxLineBytes, options.MaxPendingRequests);
using var client = new LicenseClient(LicenseConfig.Production(options.AppVersion), store,
    options.DeviceId, handler: null, time: null, log: null);
client.Channel = new OriginalProofChannel(rpc, options.DeviceId, () => client.Status);

// Explicit requests own refresh; Start() would create independent background timers.
await rpc.Run(async (request, cancellationToken) =>
{
    switch (request.GetProperty("method").GetString())
    {
        case "app.hello":
            return new { engineVersion = BrokerRpc.EngineVersion, protocol = 2, build = 1,
                capabilities = new[] { "app.hello", "app.ping", "app.shutdown", "local_status", "refresh", "check_series", "proof_response" } };
        case "app.ping":
            return new { };
        case "local_status":
            return SafeStatus(client.Status);
        case "refresh":
            await client.RefreshAsync(cancellationToken);
            return SafeStatus(client.Status);
        case "check_series":
        {
            var seriesId = request.GetProperty("params").GetProperty("seriesId").GetString();
            if (string.IsNullOrWhiteSpace(seriesId)) throw new BrokerFailure("invalid_series_id");
            var decision = await client.CheckSeriesAsync(seriesId, cancellationToken);
            return new { allowed = decision.Allowed, reason = SafeReason(decision.Reason),
                freeUsed = decision.FreeUsed, freeLimit = decision.FreeLimit,
                licensed = decision.Licensed, downloadPerformed = false };
        }
        default:
            throw new BrokerFailure("unknown_method");
    }
});

static object SafeStatus(LicenseStatus status) => new
{
    mode = status.Mode.ToString(), reason = SafeReason(status.Reason),
    licensed = status.Licensed, hasKey = status.HasKey, pcOnly = status.PcOnly,
};

static string SafeReason(string? reason) => reason is not null
    && Regex.IsMatch(reason, "\\A[a-z][a-z0-9_]{0,63}\\z", RegexOptions.CultureInvariant)
        ? reason : "license_reason_unavailable";

sealed class BrokerFailure(string code) : Exception(code)
{
    public string Code { get; } = code;
}
