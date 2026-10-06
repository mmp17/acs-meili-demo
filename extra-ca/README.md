# Extra CA certificates (optional)

If HTTPS traffic on your machine is inspected (corporate proxy, antivirus "HTTPS
scanning"), image builds fail with `certificate verify failed` because the
inspecting root CA is trusted by Windows but not inside containers.

Drop that root CA here as a PEM file ending in `.crt` and rebuild. The
certificates are only used at build time to reach GitLab, PyPI and npm.
`*.crt` files are git-ignored because they are specific to one machine.
