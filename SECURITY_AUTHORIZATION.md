# Scan authorization

The operator who runs Mnag.pt is the sole authorized user of the security scanning module.

Before any target other than `127.0.0.1/32` is scanned, that operator must list only networks they own or are otherwise authorized to scan in `config/scan-scope.yaml` (`authorized_networks`). Hosts that must never be scanned go in `excluded_hosts`. With `lab_mode: true`, the scanner accepts only `127.0.0.1/32`, `::1`, and the optional `lab_networks` list.

The running scanner enforces that YAML. This file is the human record. It does not by itself authorize a target.

Signature: _______________________________

Date: _______________________________

Name: _______________________________
