#!/usr/bin/env python3
"""
generate_devices_csv.py

Generate a dummy CSV for devices with columns:
  - name (str)
  - device_type (str)
  - ip_address (str or empty)

Usage:
  python generate_devices_csv.py --rows 100 --out devices_sample.csv
  python generate_devices_csv.py --rows 10 --out -    # prints CSV to stdout
"""

from __future__ import annotations

import argparse
import csv
import random
import sys
from collections.abc import Iterable

DEFAULT_DEVICE_TYPES = ["sensor", "gateway", "actuator", "camera", "router"]


def random_name(prefix: str = "device", idx: int | None = None) -> str:
    """Return a random device name (keeps it readable)."""
    suffix = idx if idx is not None else random.randint(1, 99999)
    return f"{prefix}-{suffix}"


def random_device_type(choices: list[str] = DEFAULT_DEVICE_TYPES) -> str:
    return random.choice(choices)


def random_ipv4() -> str:
    """Generate a random private IPv4 address (RFC1918)."""
    # choose from 10.0.0.0/8, 172.16.0.0/12, or 192.168.0.0/16
    block = random.choice([10, 172, 192])
    if block == 10:
        return f"10.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}"
    if block == 172:
        return f"172.{random.randint(16,31)}.{random.randint(0,255)}.{random.randint(1,254)}"
    return f"192.168.{random.randint(0,255)}.{random.randint(1,254)}"


def maybe_missing(value: str, missing_rate: float = 0.0) -> str | None:
    """Return value or empty string to simulate missing fields."""
    if random.random() < missing_rate:
        return ""
    return value


def generate_row(idx: int, missing_ip_rate: float = 0.0) -> dict:
    return {
        "name": random_name(idx=idx),
        "device_type": random_device_type(),
        "ip_address": maybe_missing(random_ipv4(), missing_rate=missing_ip_rate),
    }


def generate_rows(count: int, missing_ip_rate: float = 0.0) -> Iterable[dict]:
    for i in range(1, count + 1):
        yield generate_row(i, missing_ip_rate=missing_ip_rate)


def write_csv(rows: Iterable[dict], out_file) -> None:
    fieldnames = ["name", "device_type", "ip_address"]
    writer = csv.DictWriter(out_file, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow(row)


def parse_args():
    p = argparse.ArgumentParser(description="Generate dummy devices CSV")
    p.add_argument("--rows", "-n", type=int, default=10, help="Number of rows to generate")
    p.add_argument("--out", "-o", type=str, default="devices_sample.csv",
                   help="Output filename, use '-' for stdout")
    p.add_argument("--missing-ip-rate", type=float, default=0.0,
                   help="Fraction [0.0-1.0] of rows that have missing ip_address")
    return p.parse_args()


def main():
    args = parse_args()
    rows = generate_rows(args.rows, missing_ip_rate=args.missing_ip_rate)

    if args.out == "-":
        # write to stdout
        write_csv(rows, sys.stdout)
    else:
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            write_csv(rows, f)


if __name__ == "__main__":
    main()
