# VenStudio media host image: nginx with the read-only file aliases baked in, so a Coolify service needs no
# bind-mounted config file. Unprivileged nginx, so it can run as the Hermes user (see hermes-files.coolify.yml).
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY hermes-files.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8000
