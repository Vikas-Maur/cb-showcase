#!/usr/bin/env bash
# Shaped links for the lab's clients: one network namespace per party (cfl0, cfl1, …), each a veth pair plus NAT out of
# the box's main interface. All shaping is inside the namespace: upload with netem on the namespace's end of the veth,
# download with netem on an IFB device inside the namespace (the veth's ingress redirected to it). The box's main
# interface never gets a qdisc. Run as a user with sudo.
#
#   netns.sh up N                 create cfl0..cfl{N-1} (idempotent)
#   netns.sh profile I NAME       shape cflI: none | good | 4g | 3g | bad
#   netns.sh hole I on|off        cflI drops every packet both ways (a dead link, not a reset), or stops dropping
#   netns.sh exec I CMD…          run CMD inside cflI as the calling user
#   netns.sh down                 remove every cfl namespace, the NAT rule, and restore ip_forward
#
# Profiles, per direction (so the round trip adds twice the delay; loss applies each way):
#   good  20 Mbit/s, 15 ms               (≈ 20 Mbps / 30 ms RTT)
#   4g     5 Mbit/s, 40 ms, 0.5% loss    (≈ 5 Mbps / 80 ms)
#   3g     1 Mbit/s, 100 ms, 1% loss     (≈ 1 Mbps / 200 ms)
#   bad  256 kbit/s, 200 ms ± 50 ms normal jitter, 3% loss  (≈ 256 kbps / 400 ms)
# These add to the box's own path to Cloudflare's edge (measured and reported with each run).
set -euo pipefail
SUBNET=10.77.0.0/16
STATE=/tmp/cflab-netns.state
MAIN=$(ip route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
ns() { echo "cfl$1"; }

shape_args() {
  case "$1" in
    none) echo "" ;;
    good) echo "delay 15ms rate 20mbit" ;;
    4g) echo "delay 40ms loss 0.5% rate 5mbit" ;;
    3g) echo "delay 100ms loss 1% rate 1mbit" ;;
    bad) echo "delay 200ms 50ms distribution normal loss 3% rate 256kbit" ;;
    *) echo "unknown profile $1" >&2; exit 2 ;;
  esac
}

up_one() {
  local i=$1 n; n=$(ns "$i")
  ip netns list | grep -qw "$n" && return 0
  sudo ip netns add "$n"
  sudo ip link add "vcfl${i}a" type veth peer name "vcfl${i}b"
  sudo ip link set "vcfl${i}b" netns "$n"
  sudo ip addr add "10.77.${i}.1/24" dev "vcfl${i}a"
  sudo ip link set "vcfl${i}a" up
  sudo ip netns exec "$n" ip addr add "10.77.${i}.2/24" dev "vcfl${i}b"
  sudo ip netns exec "$n" ip link set "vcfl${i}b" up
  sudo ip netns exec "$n" ip link set lo up
  sudo ip netns exec "$n" ip route add default via "10.77.${i}.1"
  # download shaping: the veth's ingress through an IFB device, both inside the namespace
  sudo ip netns exec "$n" ip link add ifb0 type ifb
  sudo ip netns exec "$n" ip link set ifb0 up
  sudo ip netns exec "$n" tc qdisc add dev "vcfl${i}b" handle ffff: ingress
  sudo ip netns exec "$n" tc filter add dev "vcfl${i}b" parent ffff: matchall action mirred egress redirect dev ifb0
  sudo mkdir -p "/etc/netns/$n"
  # the namespace resolves through public resolvers (the host's stub at 127.0.0.53 isn't reachable from inside)
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' | sudo tee "/etc/netns/$n/resolv.conf" >/dev/null
}

case "${1:-}" in
  up)
    [ -f "$STATE" ] || cat /proc/sys/net/ipv4/ip_forward > "$STATE"
    sudo sysctl -qw net.ipv4.ip_forward=1
    sudo modprobe ifb numifbs=0
    sudo iptables -t nat -C POSTROUTING -s "$SUBNET" -o "$MAIN" -j MASQUERADE -m comment --comment cflab 2>/dev/null ||
      sudo iptables -t nat -A POSTROUTING -s "$SUBNET" -o "$MAIN" -j MASQUERADE -m comment --comment cflab
    for ((i = 0; i < $2; i++)); do up_one "$i"; done
    ;;
  profile)
    n=$(ns "$2"); a=$(shape_args "$3")
    for dev in "vcfl${2}b" ifb0; do
      sudo ip netns exec "$n" tc qdisc del dev "$dev" root 2>/dev/null || true
      # a generous queue: at 256 kbit/s with 250 ms of delay, netem's default 1000 packets is the floor
      [ -n "$a" ] && sudo ip netns exec "$n" tc qdisc add dev "$dev" root handle 1: netem limit 10000 $a
    done
    echo "$3" | sudo tee "/tmp/cflab-profile-$n" >/dev/null
    ;;
  hole)
    n=$(ns "$2"); p=$(cat "/tmp/cflab-profile-$n" 2>/dev/null || echo none); a=$(shape_args "$p")
    for dev in "vcfl${2}b" ifb0; do
      sudo ip netns exec "$n" tc qdisc del dev "$dev" root 2>/dev/null || true
      if [ "$3" = on ]; then sudo ip netns exec "$n" tc qdisc add dev "$dev" root handle 1: netem loss 100%
      elif [ -n "$a" ]; then sudo ip netns exec "$n" tc qdisc add dev "$dev" root handle 1: netem limit 10000 $a; fi
    done
    ;;
  exec)
    n=$(ns "$2"); shift 2
    exec sudo ip netns exec "$n" sudo -u "$(id -un)" env "PATH=$PATH" "HOME=$HOME" "$@"
    ;;
  down)
    for n in $(ip netns list | awk '{print $1}' | grep '^cfl[0-9]*$' || true); do
      i=${n#cfl}
      sudo ip netns del "$n" || true
      sudo ip link del "vcfl${i}a" 2>/dev/null || true
      sudo rm -rf "/etc/netns/$n" "/tmp/cflab-profile-$n"
    done
    while sudo iptables -t nat -D POSTROUTING -s "$SUBNET" -o "$MAIN" -j MASQUERADE -m comment --comment cflab 2>/dev/null; do :; done
    [ -f "$STATE" ] && sudo sysctl -qw "net.ipv4.ip_forward=$(cat "$STATE")" && rm -f "$STATE"
    echo "removed; ip_forward=$(cat /proc/sys/net/ipv4/ip_forward)"
    ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
