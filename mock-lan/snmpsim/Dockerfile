# Mock SNMP agent for pingsvc's discovery-mechanism dev/test environment
# (plan/device-discovery-v1.md §2.9) -- serves canned OID data from
# fixtures/, completely decoupled from the container's real network state.
# lextudio/snmpsim is the maintained fork (etingof/snmpsim is dormant).
FROM python:3.12-slim
RUN pip install --no-cache-dir snmpsim-lextudio
COPY fixtures/ /usr/local/share/snmpsim/data/
EXPOSE 161/udp
# Runs as root (this is a throwaway dev/test fixture container, not
# production) -- snmpsim-command-responder insists on being told to drop
# privileges to *some* user/group even when there's none to drop to.
ENTRYPOINT ["snmpsim-command-responder", "--data-dir=/usr/local/share/snmpsim/data", "--agent-udpv4-endpoint=0.0.0.0:161", "--process-user=root", "--process-group=root"]
