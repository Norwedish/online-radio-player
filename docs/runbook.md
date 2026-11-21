# Operations runbook

This runbook is completed in M15.3. The current plan version is in [`PLAN.md`](../PLAN.md) §10.

Quick checks:

```bash
systemctl status radio-api radio-playout radio-icecast radio-stereotool
journalctl -u radio-playout -f
curl -s localhost:3001/api/health
curl -s localhost:3001/api/ready
```
