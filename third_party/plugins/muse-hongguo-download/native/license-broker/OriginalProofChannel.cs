using Hongguo.Licensing;

sealed class OriginalProofChannel(BrokerRpc rpc, string deviceId, Func<LicenseStatus> status) : IProofChannel
{
    public async Task<ProofTicket?> ChallengeAsync(ProofPurpose purpose, string? seriesId, CancellationToken cancellationToken)
    {
        var result = await rpc.Callback("license.challenge", new
        {
            purpose = purpose switch
            {
                ProofPurpose.Licence => "licence",
                ProofPurpose.Series => "series",
                _ => throw new BrokerFailure("invalid_proof_purpose"),
            },
            seriesId,
        }, cancellationToken);
        var returnedDevice = result.GetProperty("deviceId").GetString();
        var nonce = result.GetProperty("nonce").GetString();
        if (returnedDevice != deviceId || string.IsNullOrEmpty(nonce))
            throw new BrokerFailure("helper_device_mismatch");
        return new ProofTicket(nonce, returnedDevice);
    }

    public async Task ProveAsync(ProofTicket ticket, SignedReply reply, CancellationToken cancellationToken)
    {
        if (ticket.DeviceId != deviceId || ticket.Nonce != reply.Nonce)
            throw new BrokerFailure("proof_ticket_mismatch");
        // The original LicenseCourier preserves signed response bytes as Base64.
        await rpc.Callback("license.prove", new { nonce = reply.Nonce, ts = reply.Ts,
            sig = reply.Sig, kid = reply.Kid, body = Convert.ToBase64String(reply.Body) }, cancellationToken);
    }

    public async Task ClearAsync(CancellationToken cancellationToken)
    {
        await rpc.Callback("license.clear", new { }, cancellationToken);
        var current = status();
        if (!current.Licensed && current.Mode != LicenseMode.Checking)
            await rpc.Callback("license.set", new { mode = "free" }, cancellationToken);
    }
}
