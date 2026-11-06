CPUUtilization/MemoryUtilization metrics (CloudWatch, moth rk2qo) show
ghost-phase2 Lightsail Container Service running well under Micro's
(1GB RAM / 0.25vCPU, $10/mo) capacity:

- CPU: mean 8%, one max spike 98.6% (single-day sample, likely boot/burst,
  not sustained)
- Memory: mean 17.6%, max 33.6% of Micro's 1GB (~344MB peak)

Nano tier (512MB RAM / 0.25vCPU, $7/mo) has identical CPU allocation and
would leave ~33% headroom on the observed memory peak.

Caveat: sample is only ~24h since 2026-09-10 cutover to phase2 (Lightsail),
no real traffic spike observed yet. Don't downgrade off this alone — let
metrics run 1-2 weeks under real traffic first, then decide.

## Decision needed

Downgrade to Nano (saves $3/mo, ~25% of compute cost) if sustained
utilization over a longer window confirms headroom holds under real
traffic, including any traffic spikes.
