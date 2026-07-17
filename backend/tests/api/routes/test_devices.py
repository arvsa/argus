"""
CRUD lifecycle tests for /devices -- see plan/device-node-assignment-bridge-v1.md.

Requires a live DB (run inside Docker: docker compose exec backend pytest).
"""

import hashlib
import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import get_superuser_token_headers, random_lower_string

API = settings.API_V1_STR


def _su(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def _root_type(client: TestClient, headers: dict[str, str], tenant_id: str) -> dict:
    return client.post(
        f"{API}/node-types/",
        headers=headers,
        json={"tenant_id": tenant_id, "name": "Region", "rank": 0},
    ).json()


def _root_node(client: TestClient, headers: dict[str, str], node_type_id: str) -> dict:
    return client.post(
        f"{API}/nodes/",
        headers=headers,
        json={"name": "Main Region", "node_type_id": node_type_id},
    ).json()


def _child_type(
    client: TestClient, headers: dict[str, str], tenant_id: str, parent_type_id: str
) -> dict:
    return client.post(
        f"{API}/node-types/",
        headers=headers,
        json={
            "tenant_id": tenant_id,
            "name": "Site",
            "rank": 1,
            "parent_type_id": parent_type_id,
        },
    ).json()


def _child_node(
    client: TestClient, headers: dict[str, str], node_type_id: str, parent_id: str
) -> dict:
    return client.post(
        f"{API}/nodes/",
        headers=headers,
        json={
            "name": "Main Site",
            "node_type_id": node_type_id,
            "parent_id": parent_id,
        },
    ).json()


def test_create_device_without_node(client: TestClient) -> None:
    headers = _su(client)
    addr = f"10.0.0.{random_lower_string()[:1]}"
    r = client.post(f"{API}/devices/", headers=headers, json={"addr": addr})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["addr"] == addr
    assert data["node_id"] is None


def test_create_device_with_node(client: TestClient) -> None:
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node = _root_node(client, headers, root_type["id"])

    r = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "192.0.2.50", "node_id": node["id"]},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["node_id"] == node["id"]


def test_create_device_duplicate_addr_returns_400(client: TestClient) -> None:
    headers = _su(client)
    addr = "192.0.2.51"
    r1 = client.post(f"{API}/devices/", headers=headers, json={"addr": addr})
    assert r1.status_code == 200, r1.text

    r2 = client.post(f"{API}/devices/", headers=headers, json={"addr": addr})
    assert r2.status_code == 400, r2.text


def test_create_device_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    r = client.post(
        f"{API}/devices/",
        headers=normal_user_token_headers,
        json={"addr": "192.0.2.52"},
    )
    assert r.status_code == 403


def test_read_device(client: TestClient) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.53"}
    ).json()
    r = client.get(f"{API}/devices/{created['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == created["id"]


def test_read_device_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.get(f"{API}/devices/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404


def test_list_devices(client: TestClient) -> None:
    headers = _su(client)
    client.post(f"{API}/devices/", headers=headers, json={"addr": "192.0.2.54"})
    r = client.get(f"{API}/devices/", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "data" in body and "count" in body
    assert body["count"] >= 1


def test_list_devices_filters_by_node_id(client: TestClient) -> None:
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node_a = _root_node(client, headers, root_type["id"])
    node_b = client.post(
        f"{API}/nodes/",
        headers=headers,
        json={"name": "Other Region", "node_type_id": root_type["id"]},
    ).json()

    dev_a = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "192.0.2.55", "node_id": node_a["id"]},
    ).json()
    dev_b = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "192.0.2.56", "node_id": node_b["id"]},
    ).json()

    r = client.get(f"{API}/devices/?node_id={node_a['id']}", headers=headers)
    assert r.status_code == 200, r.text
    ids = [d["id"] for d in r.json()["data"]]
    assert dev_a["id"] in ids
    assert dev_b["id"] not in ids


def test_update_device(client: TestClient) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.57"}
    ).json()
    new_addr = "192.0.2.58"
    r = client.patch(
        f"{API}/devices/{created['id']}", headers=headers, json={"addr": new_addr}
    )
    assert r.status_code == 200, r.text
    assert r.json()["addr"] == new_addr


def test_update_device_can_set_mac(client: TestClient) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.63"}
    ).json()
    r = client.patch(
        f"{API}/devices/{created['id']}",
        headers=headers,
        json={"mac": "AA:BB:CC:DD:EE:04"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["mac"] == "AA:BB:CC:DD:EE:04"


def test_update_device_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.59"}
    ).json()
    r = client.patch(
        f"{API}/devices/{created['id']}",
        headers=normal_user_token_headers,
        json={"addr": "192.0.2.60"},
    )
    assert r.status_code == 403


def test_delete_device(client: TestClient) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.61"}
    ).json()
    r = client.delete(f"{API}/devices/{created['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert (
        client.get(f"{API}/devices/{created['id']}", headers=headers).status_code == 404
    )


def test_delete_device_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.62"}
    ).json()
    r = client.delete(
        f"{API}/devices/{created['id']}", headers=normal_user_token_headers
    )
    assert r.status_code == 403


def test_reassigning_orphaned_device_addr_succeeds(client: TestClient) -> None:
    """POST /devices/ with an addr that already exists but is orphaned
    (node_id is NULL, e.g. because its Node was deleted) must reassign the
    existing row to the new node_id instead of rejecting with a 400 --
    otherwise a device can never be re-added anywhere once its node is
    removed."""
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node_a = _root_node(client, headers, root_type["id"])
    node_b = client.post(
        f"{API}/nodes/",
        headers=headers,
        json={"name": "Other Region", "node_type_id": root_type["id"]},
    ).json()

    addr = "192.0.2.64"
    device = client.post(
        f"{API}/devices/", headers=headers, json={"addr": addr, "node_id": node_a["id"]}
    ).json()

    r = client.delete(f"{API}/nodes/{node_a['id']}", headers=headers)
    assert r.status_code == 200, r.text

    r = client.post(
        f"{API}/devices/", headers=headers, json={"addr": addr, "node_id": node_b["id"]}
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["id"] == device["id"]
    assert data["node_id"] == node_b["id"]


def test_reassigning_actively_assigned_device_addr_still_returns_400(
    client: TestClient,
) -> None:
    """The orphaned-reassignment path must not weaken the existing conflict
    check: an addr that's still actively assigned to a node stays a 400."""
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node_a = _root_node(client, headers, root_type["id"])
    node_b = client.post(
        f"{API}/nodes/",
        headers=headers,
        json={"name": "Other Region", "node_type_id": root_type["id"]},
    ).json()

    addr = "192.0.2.65"
    client.post(
        f"{API}/devices/", headers=headers, json={"addr": addr, "node_id": node_a["id"]}
    )

    r = client.post(
        f"{API}/devices/", headers=headers, json={"addr": addr, "node_id": node_b["id"]}
    )
    assert r.status_code == 400, r.text


def test_deleting_node_sets_device_node_id_to_null(client: TestClient) -> None:
    """A Device's node assignment must be orphaned (node_id -> NULL), not
    cascade-deleted, when its Node is removed -- the device record itself
    still represents a real, monitored address."""
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node = _root_node(client, headers, root_type["id"])
    device = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "192.0.2.63", "node_id": node["id"]},
    ).json()

    r = client.delete(f"{API}/nodes/{node['id']}", headers=headers)
    assert r.status_code == 200, r.text

    r = client.get(f"{API}/devices/{device['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["node_id"] is None


def test_targets_export_format(client: TestClient) -> None:
    """GET /devices/targets-export must produce pingsvc's exact
    "addr,ancestor1;ancestor2;..." format (see
    pingsvc/cmd/pingsvc/main.go's parseTargetLine): root-first ancestors
    from Node.path_ids, then the assigned node itself last."""
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    child_type = _child_type(client, headers, tenant_id, root_type["id"])
    root = _root_node(client, headers, root_type["id"])
    child = _child_node(client, headers, child_type["id"], root["id"])

    client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "203.0.113.10", "node_id": child["id"]},
    )
    client.post(f"{API}/devices/", headers=headers, json={"addr": "203.0.113.11"})

    r = client.get(f"{API}/devices/targets-export", headers=headers)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/plain")

    lines = r.text.strip("\n").split("\n")
    assert f"203.0.113.10,{root['id']};{child['id']}" in lines
    assert "203.0.113.11" in lines


def test_targets_export_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    r = client.get(f"{API}/devices/targets-export", headers=normal_user_token_headers)
    assert r.status_code == 403


def test_targets_export_succeeds_regardless_of_device_count(client: TestClient) -> None:
    """Smoke test the endpoint in isolation (other tests in this module
    don't clean up their devices, so this can't assert an empty body) --
    it must never 404/500, including on a fresh deployment with zero
    devices."""
    headers = _su(client)
    r = client.get(f"{API}/devices/targets-export", headers=headers)
    assert r.status_code == 200, r.text


def test_targets_export_device_without_mac_is_byte_identical_to_today(
    client: TestClient,
) -> None:
    """Regression sentinel (plan/device-discovery-v1.md §3 step 1): a
    device with no mac on file must still produce the plain
    "addr,ancestor1;ancestor2;..." line -- no third field, no trailing
    comma -- exactly what pingsvc's parseTargetLine has always accepted."""
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    root = _root_node(client, headers, root_type["id"])

    client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "203.0.113.30", "node_id": root["id"]},
    )

    r = client.get(f"{API}/devices/targets-export", headers=headers)
    lines = r.text.strip("\n").split("\n")
    assert f"203.0.113.30,{root['id']}" in lines


def test_targets_export_includes_mac_as_third_field_for_assigned_device(
    client: TestClient,
) -> None:
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    root = _root_node(client, headers, root_type["id"])

    created = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "203.0.113.31", "node_id": root["id"]},
    ).json()
    client.patch(
        f"{API}/devices/{created['id']}",
        headers=headers,
        json={"mac": "AA:BB:CC:DD:EE:01"},
    )

    r = client.get(f"{API}/devices/targets-export", headers=headers)
    lines = r.text.strip("\n").split("\n")
    assert f"203.0.113.31,{root['id']},AA:BB:CC:DD:EE:01" in lines


def test_targets_export_unassigned_device_with_mac_uses_empty_middle_field(
    client: TestClient,
) -> None:
    """An unassigned device (no node) that has a known mac must emit
    "addr,,mac" -- empty middle field -- not "addr,mac", which would be
    indistinguishable from the existing 2-field "assigned, no mac" format
    and get misparsed as a bogus single-entry NodeIDs chain."""
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "203.0.113.32"}
    ).json()
    client.patch(
        f"{API}/devices/{created['id']}",
        headers=headers,
        json={"mac": "AA:BB:CC:DD:EE:02"},
    )

    r = client.get(f"{API}/devices/targets-export", headers=headers)
    lines = r.text.strip("\n").split("\n")
    assert "203.0.113.32,,AA:BB:CC:DD:EE:02" in lines


def test_targets_hash_matches_sha256_of_export_body_with_mac_field(
    client: TestClient,
) -> None:
    su_headers = _su(client)
    addr = "203.0.113.33"
    created = client.post(
        f"{API}/devices/", headers=su_headers, json={"addr": addr}
    ).json()
    client.patch(
        f"{API}/devices/{created['id']}",
        headers=su_headers,
        json={"mac": "AA:BB:CC:DD:EE:03"},
    )

    export = client.get(f"{API}/devices/targets-export", headers=su_headers)
    assert export.status_code == 200, export.text
    expected = hashlib.sha256(export.text.encode()).hexdigest()

    r = client.get(f"{API}/devices/targets-hash", headers=_pingsvc_headers())
    assert r.status_code == 200, r.text
    assert r.json()["hash"] == expected


# ── pingsvc target sync (targets-hash / targets-export-internal) ──────────
# See plan for "Live Target Sync (pingsvc hot-reload)": pingsvc has no user
# account, so these routes are gated by a separate shared-secret token
# (settings.PINGSVC_SYNC_TOKEN via the X-Pingsvc-Token header), not
# get_current_active_superuser -- a normal human JWT must not work here.


def _pingsvc_headers() -> dict[str, str]:
    return {"X-Pingsvc-Token": settings.PINGSVC_SYNC_TOKEN}


def test_targets_hash_requires_pingsvc_token(client: TestClient) -> None:
    r = client.get(f"{API}/devices/targets-hash")
    assert r.status_code == 401


def test_targets_hash_rejects_wrong_pingsvc_token(client: TestClient) -> None:
    r = client.get(
        f"{API}/devices/targets-hash", headers={"X-Pingsvc-Token": "not-the-real-token"}
    )
    assert r.status_code == 401


def test_targets_hash_rejects_a_superuser_jwt(client: TestClient) -> None:
    """A human superuser JWT must not work here -- this is a distinct
    credential from CurrentUser/get_current_active_superuser, on purpose."""
    headers = _su(client)
    r = client.get(f"{API}/devices/targets-hash", headers=headers)
    assert r.status_code == 401


def test_targets_hash_matches_sha256_of_export_body(client: TestClient) -> None:
    su_headers = _su(client)
    addr = "203.0.113.20"
    client.post(f"{API}/devices/", headers=su_headers, json={"addr": addr})

    export = client.get(f"{API}/devices/targets-export", headers=su_headers)
    assert export.status_code == 200, export.text
    expected = hashlib.sha256(export.text.encode()).hexdigest()

    r = client.get(f"{API}/devices/targets-hash", headers=_pingsvc_headers())
    assert r.status_code == 200, r.text
    assert r.json()["hash"] == expected


def test_targets_hash_changes_when_a_device_is_added(client: TestClient) -> None:
    su_headers = _su(client)
    before = client.get(
        f"{API}/devices/targets-hash", headers=_pingsvc_headers()
    ).json()["hash"]

    client.post(f"{API}/devices/", headers=su_headers, json={"addr": "203.0.113.21"})

    after = client.get(
        f"{API}/devices/targets-hash", headers=_pingsvc_headers()
    ).json()["hash"]
    assert before != after


def test_targets_hash_stable_when_nothing_changed(client: TestClient) -> None:
    r1 = client.get(f"{API}/devices/targets-hash", headers=_pingsvc_headers())
    r2 = client.get(f"{API}/devices/targets-hash", headers=_pingsvc_headers())
    assert r1.json()["hash"] == r2.json()["hash"]


def test_targets_export_internal_requires_pingsvc_token(client: TestClient) -> None:
    r = client.get(f"{API}/devices/targets-export-internal")
    assert r.status_code == 401


def test_targets_export_internal_rejects_a_superuser_jwt(client: TestClient) -> None:
    headers = _su(client)
    r = client.get(f"{API}/devices/targets-export-internal", headers=headers)
    assert r.status_code == 401


# ── Bulk import (plan/device-naming-and-bulk-import-v1.md §2.6) ─────────
# CSV parsing happens client-side; this endpoint takes pre-parsed JSON
# rows and applies the exact same per-row duplicate/orphan-reassignment
# logic as POST /devices/, reporting a per-row outcome instead of
# all-or-nothing.


def test_bulk_import_creates_new_devices(client: TestClient) -> None:
    headers = _su(client)
    r = client.post(
        f"{API}/devices/bulk-import",
        headers=headers,
        json={
            "rows": [
                {"addr": "203.0.113.50", "hostname": "floor-1-switch"},
                {"addr": "203.0.113.51", "hostname": "floor-2-switch"},
            ]
        },
    )
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert len(results) == 2
    assert all(res["outcome"] == "created" for res in results)
    assert results[0]["device"]["hostname"] == "floor-1-switch"
    assert results[1]["device"]["hostname"] == "floor-2-switch"


def test_bulk_import_skips_unassigned_duplicate_addr(client: TestClient) -> None:
    headers = _su(client)
    addr = "203.0.113.52"
    client.post(f"{API}/devices/", headers=headers, json={"addr": addr})

    r = client.post(
        f"{API}/devices/bulk-import",
        headers=headers,
        json={"rows": [{"addr": addr}]},
    )
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert results[0]["outcome"] == "skipped_duplicate"


def test_bulk_import_skips_already_assigned_elsewhere_addr(client: TestClient) -> None:
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node_a = _root_node(client, headers, root_type["id"])
    node_b = client.post(
        f"{API}/nodes/",
        headers=headers,
        json={"name": "Other Region", "node_type_id": root_type["id"]},
    ).json()

    addr = "203.0.113.53"
    client.post(
        f"{API}/devices/", headers=headers, json={"addr": addr, "node_id": node_a["id"]}
    )

    r = client.post(
        f"{API}/devices/bulk-import",
        headers=headers,
        json={"rows": [{"addr": addr, "node_id": node_b["id"]}]},
    )
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert results[0]["outcome"] == "skipped_duplicate"


def test_bulk_import_reassigns_orphaned_addr_when_node_given(client: TestClient) -> None:
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node_a = _root_node(client, headers, root_type["id"])
    node_b = client.post(
        f"{API}/nodes/",
        headers=headers,
        json={"name": "Other Region", "node_type_id": root_type["id"]},
    ).json()

    addr = "203.0.113.54"
    device = client.post(
        f"{API}/devices/", headers=headers, json={"addr": addr, "node_id": node_a["id"]}
    ).json()
    client.delete(f"{API}/nodes/{node_a['id']}", headers=headers)

    r = client.post(
        f"{API}/devices/bulk-import",
        headers=headers,
        json={"rows": [{"addr": addr, "node_id": node_b["id"]}]},
    )
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert results[0]["outcome"] == "reassigned"
    assert results[0]["device"]["id"] == device["id"]
    assert results[0]["device"]["node_id"] == node_b["id"]


def test_bulk_import_reports_malformed_row_without_blocking_others(
    client: TestClient,
) -> None:
    headers = _su(client)
    r = client.post(
        f"{API}/devices/bulk-import",
        headers=headers,
        json={
            "rows": [
                {"addr": "203.0.113.55"},
                {"hostname": "no-addr-here"},
                {"addr": "203.0.113.56"},
            ]
        },
    )
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert len(results) == 3
    assert results[0]["outcome"] == "created"
    assert results[1]["outcome"] == "error"
    assert results[1]["error"]
    assert results[2]["outcome"] == "created"


def test_bulk_import_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    r = client.post(
        f"{API}/devices/bulk-import",
        headers=normal_user_token_headers,
        json={"rows": [{"addr": "203.0.113.57"}]},
    )
    assert r.status_code == 403


def test_targets_export_internal_matches_human_facing_export(
    client: TestClient,
) -> None:
    su_headers = _su(client)
    client.post(f"{API}/devices/", headers=su_headers, json={"addr": "203.0.113.22"})

    human = client.get(f"{API}/devices/targets-export", headers=su_headers)
    internal = client.get(
        f"{API}/devices/targets-export-internal", headers=_pingsvc_headers()
    )
    assert internal.status_code == 200, internal.text
    assert internal.text == human.text
    assert internal.headers["content-type"].startswith("text/plain")
