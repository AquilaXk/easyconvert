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
   For production Kubernetes/OKE deployments, configure the worker Pod with the worker Seccomp Profile (see D12; `seccomp-airgap.json` blocks sockets and cannot be applied to the worker itself, which talks to Redis and storage) and a restrictive NetworkPolicy:

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
      localhostProfile: seccomp-worker.json
  containers:
    - name: worker
      image: easyconvert-worker:latest
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
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
    # Restrict egress to the local Redis queue and the internal Object Storage endpoint
    - to:
        - podSelector:
            matchLabels:
              app: easyconvert-redis
      ports:
        - protocol: TCP
          port: 6379
    # Name resolution for the image fetcher (cluster DNS)
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # HTML to PDF fetches the public images of a page (HTML_IMAGE_FETCH=on, the default): TCP 80 and 443 to public
    # addresses only. The blocks excepted here are the ones src/lib/conversions/public-address.ts refuses; the code
    # checks every address too, this rule is the second layer should that check ever have a flaw.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 0.0.0.0/8
              - 10.0.0.0/8
              - 100.64.0.0/10
              - 127.0.0.0/8
              - 169.254.0.0/16
              - 172.16.0.0/12
              - 192.0.0.0/24
              - 192.0.2.0/24
              - 192.88.99.0/24
              - 192.168.0.0/16
              - 198.18.0.0/15
              - 198.51.100.0/24
              - 203.0.113.0/24
              - 224.0.0.0/4
              - 240.0.0.0/4
        - ipBlock:
            # Global unicast only; everything outside 2000::/3 (loopback, fc00::/7, fe80::/10, multicast, NAT64,
            # IPv4-compatible and IPv4-mapped forms) is therefore not reachable.
            cidr: 2000::/3
            except:
              - 2001::/23
              - 2001:db8::/32
              - 2002::/16
              - 3fff::/20
      ports:
        - protocol: TCP
          port: 80
        - protocol: TCP
          port: 443
```

### Image fetching and the worker

HTML to PDF fetches the `http` and `https` images a page names so that they appear in the PDF. The worker process itself never opens those connections: each fetch runs in a short-lived child process (`html-image-fetch-child`) that starts with a stripped environment (no credentials, tokens or proxy variables), only the three standard streams, and CPU and file-size limits, receives one URL on stdin and returns the image bytes and a verdict on stdout. The child resolves the host once, refuses every non-public address (IPv4 special-purpose blocks, and any IPv6 address outside global unicast, including mapped, compatible and NAT64 forms), connects only to the checked address, re-checks every redirect hop and the connected peer, and accepts ports 80 and 443 only. The rendering step (LibreOffice) stays network-less.

The child needs the egress rule above. A deployment with no egress for the worker keeps the original policy (Redis only) and sets `HTML_IMAGE_FETCH=off`: no image is fetched, each external image is left out of the PDF with a warning, and a request that sets `requireResources` is refused with 400.

## Decision D12: how a capability-less worker creates the per-child sandbox

**Status**: option (a) chosen; option (b) is the fallback. To be confirmed on the target arm64 host with `scripts/verify-worker-container.sh`.

**Context**: the worker container drops all capabilities (no `SYS_ADMIN`), sets `no-new-privileges`, and runs read-only. Each native child still starts through `unshare -r -n` (user and network namespaces, optionally PID and mount). Creating a user namespace needs no capability, but Docker's default seccomp profile denies `clone`, `unshare` and `setns` with namespace flags unless the container holds `CAP_SYS_ADMIN`. With the default profile and `STRICT_SANDBOX=true`, every native conversion is refused with 503 (`SandboxUnavailableError`); it never runs unsandboxed.

**Options**:

- (a) A seccomp profile, `docker/seccomp-worker.json`: the default profile's structure with `clone` and `unshare` permitted when the flags are within `CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWPID | CLONE_NEWNS`, `setns` permitted to join those four kinds, `clone3` answered with `ENOSYS` (its flags cannot be filtered), and no rule that needs a capability. The container keeps `cap_drop: ALL`.
- (b) A separate network-less runner container that executes the native tools for the worker, so the worker never creates namespaces.

**Decision**: (a). It changes one seccomp profile and nothing else about the container, and the sandbox code path stays the one the tests exercise.

**Deviations from the default profile**, all stricter: `ptrace`, `process_vm_readv` and `process_vm_writev` are denied outright (the default allows them on kernels 4.8 and later), as are `io_uring_*` and every call the default gates on a capability (none is granted here). `mount` stays denied, so a child cannot mount a fresh `/proc`; a private PID namespace therefore renumbers the child but does not hide host `/proc` entries.

**Fallback to (b)** when the host kernel forbids unprivileged user namespaces (`user.max_user_namespaces=0` or a distribution policy that blocks them) or the platform cannot load a custom seccomp profile. Strict mode then refuses conversions with 503 until the runner exists; it does not fall back to running unsandboxed.

**Open**: LibreOffice's UNO pipe across the namespace boundary is covered by `tests/libreoffice-pool-loopback-less-namespace.test.ts` on a host with namespaces, not yet inside the container. The compose worker services apply the profile (`security_opt: seccomp=./docker/seccomp-worker.json`), and the `container` job in `.github/workflows/ci.yml` runs `scripts/verify-worker-container.sh` inside the built image with the compose security settings; that job lifts `kernel.apparmor_restrict_unprivileged_userns` on the runner, which restricts user namespaces by default.
