using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

sealed class BrokerRpc(CancellationTokenSource stop, int maxLineBytes, int maxPendingRequests)
{
    public const string EngineVersion = "muse-hongguo-license-broker-1";
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> callbacks = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> requests = new();
    private readonly SemaphoreSlim output = new(1, 1);
    private readonly object callbackLock = new();
    private int nextCallback;

    public async Task<JsonElement> Callback(string method, object parameters, CancellationToken cancellationToken)
    {
        var id = "proof-" + Interlocked.Increment(ref nextCallback);
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (callbackLock)
        {
            if (callbacks.Count >= maxPendingRequests) throw new BrokerFailure("callback_capacity");
            if (!callbacks.TryAdd(id, completion)) throw new BrokerFailure("callback_collision");
        }
        using var canceled = cancellationToken.Register(() => completion.TrySetCanceled(cancellationToken));
        try
        {
            await Write(new { jsonrpc = "2.0", method = "license.channel",
                @params = new { callbackId = id, method, @params = parameters } });
            return await completion.Task;
        }
        finally { lock (callbackLock) callbacks.TryRemove(id, out _); }
    }

    public async Task Run(Func<JsonElement, CancellationToken, Task<object>> execute)
    {
        await Write(new { jsonrpc = "2.0", method = "engine.ready",
            @params = new { engineVersion = EngineVersion, protocol = 2 } });
        var queue = Channel.CreateBounded<Work>(new BoundedChannelOptions(maxPendingRequests)
        {
            SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait,
        });
        var worker = Task.Run(async () =>
        {
            await foreach (var work in queue.Reader.ReadAllAsync(stop.Token))
            {
                try
                {
                    var result = await execute(work.Request, work.Cancellation.Token);
                    await Write(new { jsonrpc = "2.0", id = work.Id, result });
                }
                catch (Exception error)
                {
                    var reason = error is BrokerFailure failure ? failure.Code
                        : error is OperationCanceledException ? "canceled" : "license_operation_failed";
                    await Error(work.Id, reason);
                }
                finally
                {
                    requests.TryRemove(work.Id, out _);
                    work.Cancellation.Dispose();
                }
            }
        });
        try
        {
            while (!stop.IsCancellationRequested)
            {
                var line = await Console.In.ReadLineAsync(stop.Token);
                if (line is null) break;
                if (Encoding.UTF8.GetByteCount(line) > maxLineBytes) throw new BrokerFailure("rpc_line_too_large");
                using var document = JsonDocument.Parse(line);
                var message = document.RootElement;
                if (message.ValueKind != JsonValueKind.Object
                    || message.GetProperty("jsonrpc").GetString() != "2.0")
                    throw new BrokerFailure("invalid_request");
                var method = message.GetProperty("method").GetString();
                if (method == "$/cancelRequest")
                {
                    var cancelId = message.GetProperty("params").GetProperty("id").GetString();
                    if (cancelId is not null && requests.TryGetValue(cancelId, out var canceled))
                    {
                        try { canceled.Cancel(); }
                        catch (ObjectDisposedException error)
                        {
                            // The worker completed and disposed this request after the lookup.
                            _ = error;
                        }
                    }
                    continue;
                }
                var id = message.GetProperty("id").GetString();
                if (string.IsNullOrEmpty(id)) throw new BrokerFailure("invalid_request_id");
                if (method == "proof_response")
                {
                    // This must remain on the reader: queued handling would wait
                    // behind the SDK call that is awaiting this very response.
                    var parameters = message.GetProperty("params");
                    var callbackId = parameters.GetProperty("callbackId").GetString();
                    if (callbackId is null || !callbacks.TryGetValue(callbackId, out var completion))
                    {
                        await Error(id, "unknown_callback");
                        continue;
                    }
                    if (parameters.TryGetProperty("error", out _))
                        completion.TrySetException(new BrokerFailure("helper_rejected_proof_request"));
                    else
                        completion.TrySetResult(parameters.GetProperty("result").Clone());
                    await Write(new { jsonrpc = "2.0", id, result = new { } });
                    continue;
                }
                if (method == "app.shutdown")
                {
                    await Write(new { jsonrpc = "2.0", id, result = new { } });
                    stop.Cancel();
                    break;
                }
                if (requests.Count >= maxPendingRequests || requests.ContainsKey(id))
                {
                    await Error(id, "request_capacity");
                    continue;
                }
                var cancellation = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
                if (!requests.TryAdd(id, cancellation) || !queue.Writer.TryWrite(new Work(id, message.Clone(), cancellation)))
                {
                    requests.TryRemove(id, out _);
                    cancellation.Dispose();
                    await Error(id, "request_capacity");
                }
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        finally
        {
            stop.Cancel();
            queue.Writer.TryComplete();
            foreach (var completion in callbacks.Values) completion.TrySetCanceled(stop.Token);
            try { await worker; }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
            foreach (var cancellation in requests.Values) cancellation.Dispose();
            requests.Clear();
        }
    }

    private Task Error(string id, string reason) => Write(new { jsonrpc = "2.0", id,
        error = new { code = -32020, message = "License operation failed", data = new { reason } } });

    private async Task Write(object value)
    {
        var line = JsonSerializer.Serialize(value);
        if (Encoding.UTF8.GetByteCount(line) > maxLineBytes) throw new BrokerFailure("rpc_line_too_large");
        await output.WaitAsync();
        try { await Console.Out.WriteLineAsync(line); await Console.Out.FlushAsync(); }
        finally { output.Release(); }
    }

    private sealed record Work(string Id, JsonElement Request, CancellationTokenSource Cancellation);
}
