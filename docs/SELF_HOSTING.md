# Self-hosting

## Docker

```sh
docker run -d --name later -p 4800:4800 -v later-data:/data ghcr.io/ysta32/later:latest
```

Or with compose: copy `.env.example` to `.env`, fill in what you need, then `docker compose up -d`.

All state lives in the `/data` volume (SQLite database and files). Back it up regularly, or use the JSON export.

## Environment

| Variable                 | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `PORT`                   | Listen port (default 4800)                           |
| `LATER_DATA_DIR`         | Data directory (`/data` in Docker)                   |
| `LATER_SIGNUPS`          | Control whether new signups are allowed              |
| `LATER_INBOUND_SECRET`   | Shared secret for `/api/inbound/email`               |
| `LATER_PUBLIC_URL`       | Public base URL of your instance                     |
| `SMTP_URL`               | SMTP connection URL, used for Send to Kindle         |
| `ANTHROPIC_API_KEY`      | Enables AI features                                  |
| `LATER_AI_MODEL`         | Model name (default `claude-sonnet-5-5`)             |

## Reverse proxy

Put Later behind HTTPS (Caddy, nginx, Traefik) and set `LATER_PUBLIC_URL` to the public address.

## Health check

`GET /api/health` returns 200 when the server is up.

## Upgrading

`docker pull ghcr.io/ysta32/later:latest` and recreate the container. The data volume is preserved.
