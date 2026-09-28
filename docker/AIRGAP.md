# EasyConvert Zero-Trust Air-Gap Container Hardening

## Overview
EasyConvert enforces strict air-gap isolation for untrusted transcoding and document parsing workloads. Even if an attacker executes arbitrary code via a malicious parser payload, the process sandbox and container runtime prevent any network egress, lateral movement, or host escalation.

## Defense in Depth Layers

1. **Linux Network Namespace Isolation (`unshare -n`)**:
   - Isolates the worker child processes inside a dedicated loopback-only network namespace where no physical network interfaces exist.

2. **Docker Seccomp BPF Profile (`docker/seccomp-airgap.json`)**:
   - Filters system calls at the Linux kernel boundary using Berkley Packet Filters (BPF).
   - Returns `EPERM`/`EACCES` (`SCMP_ACT_ERRNO`) for raw network syscalls:
     `socket`, `socketpair`, `connect`, `bind`, `listen`, `accept`, `accept4`, `sendto`, `recvfrom`, `sendmsg`, `recvmsg`, `sendmmsg`, `recvmmsg`, `shutdown`, `getsockname`, `getpeername`, `getsockopt`, `setsockopt`.
   - Blocks dangerous kernel manipulation syscalls:
     `ptrace`, `bpf`, `mount`, `umount2`, `reboot`, `kexec_load`, `init_module`, `delete_module`, `iopl`, `ioperm`, `swapon`, `sysfs`.

3. **Kubernetes / OKE Pod Air-Gap Specification**:
   For production Kubernetes/OKE deployments, configure the worker Pod with Seccomp Profile and restrictive NetworkPolicy:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: easyconvert-worker-airgap
  namespace: easyconvert
  labels:
    app: easyconvert-worker
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1001
    runAsGroup: 1001
    fsGroup: 1001
    seccompProfile:
      type: Localhost
      localhostProfile: seccomp-airgap.json
  containers:
    - name: worker
      image: easyconvert-worker:latest
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
          add:
            - SYS_ADMIN # for unshare user namespace if needed
      resources:
        limits:
          cpu: "2"
          memory: "4Gi"
          ephemeral-storage: "10Gi"
        requests:
          cpu: "500m"
          memory: "1Gi"
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: easyconvert-worker-airgap-policy
  namespace: easyconvert
spec:
  podSelector:
    matchLabels:
      app: easyconvert-worker
  policyTypes:
    - Ingress
    - Egress
  egress:
    # Restrict egress strictly to local Redis queue and internal Object Storage endpoint
    - to:
        - podSelector:
            matchLabels:
              app: easyconvert-redis
      ports:
        - protocol: TCP
          port: 6379
```
