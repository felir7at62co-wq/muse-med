"""Render nginx locations for the two applications under the existing Muse TLS server."""
def gate(mount, upstream, native=False):
    block = f"""
    set $wb_original_method $request_method;
    auth_request /_muse_wb_auth_{mount};
    auth_request_set $wb_{mount}_bearer $upstream_http_x_workbench_authorization;
    proxy_set_header Authorization $wb_{mount}_bearer;
    proxy_set_header Cookie "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
    proxy_hide_header Set-Cookie;
    proxy_hide_header Cache-Control;
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Credentials;
    add_header Cache-Control "private, no-store" always;
    add_header X-Content-Type-Options nosniff always;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    client_max_body_size 2048m;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 1800s;
    access_log off;
    proxy_pass {upstream};
"""
    if native:
        block += """    add_header Content-Security-Policy "sandbox; default-src 'none'; frame-ancestors 'self'" always;\n"""
    else:
        block += """    add_header Content-Security-Policy "frame-ancestors 'self' dsh-app://app; object-src 'none'; base-uri 'self'" always;\n"""
    return block


def route(path, contents):
    return "location " + path + " {" + contents + "}\n"


def render():
    blocks = []
    for mount in ("jubengongfang", "jingliu"):
        blocks.append(route(f"= /{mount}", f" return 308 /{mount}/; "))
        blocks.append(route(f"= /_muse_wb_auth_{mount}", f"""
    internal;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
    proxy_set_header X-Workbench-Method $wb_original_method;
    proxy_set_header X-Workbench-Origin $http_origin;
    proxy_set_header X-Workbench-Path $request_uri;
    proxy_set_header Authorization "";
    access_log off;
    proxy_pass http://127.0.0.1:19740/check/{mount};
"""))
        for endpoint, kind in (("/", "enter"), ("/_session", "session")):
            blocks.append(route(f"= /{mount}{endpoint}", f"""
    proxy_set_header Cookie $http_cookie;
    proxy_set_header Authorization "";
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    access_log off;
    proxy_pass http://127.0.0.1:19740/{kind}/{mount};
"""))
        blocks.append(route(f"= /{mount}/_store.js", """
    alias /srv/muse-workbenches/current/muse_storage.js;
    default_type application/javascript;
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options nosniff always;
"""))
        blocks.append(route(f"= /{mount}/_entry.js", """
    alias /srv/muse-workbenches/current/entry.js;
    default_type application/javascript;
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options nosniff always;
"""))
    for api in ("v1", "api/v1"):
        blocks.append(route("= /jubengongfang/" + api + "/auth/muse/internal-session", " return 404; "))
        blocks.append(route("^~ /jubengongfang/" + api + "/", gate("jubengongfang", "http://127.0.0.1:19741/v1/", True)))
    for path in ("login", "register", "v1/auth/muse/login"):
        blocks.append(route("= /jubengongfang/" + path, " return 302 /jubengongfang/; "))
    blocks.append(route("^~ /jubengongfang/", gate("jubengongfang", "http://127.0.0.1:19742")))
    blocks.append(route("= /jingliu/fwp/v2/auth/muse/internal-session", " return 404; "))
    blocks.append(route("= /jingliu/fwp/v2/auth/muse/login", " return 302 /jingliu/; "))
    blocks.append(route("^~ /jingliu/fwp/", gate("jingliu", "http://127.0.0.1:19743/", True)))
    blocks.append(route("= /jingliu/sfp", " return 308 /jingliu/sfp/; "))
    blocks.append(route("^~ /jingliu/sfp/", """
    set $wb_original_method $request_method;
    auth_request /_muse_wb_auth_jingliu;
    alias /srv/muse-workbenches/current/studio-site/;
    index index.html;
    add_header Cache-Control "private, no-store" always;
    add_header Content-Security-Policy "frame-ancestors 'self' dsh-app://app; object-src 'none'; base-uri 'self'" always;
    add_header X-Content-Type-Options nosniff always;
    access_log off;
"""))
    blocks.append(route("^~ /jingliu/", " return 404; "))
    return "\n".join(blocks)


if __name__ == "__main__":
    print(render(), end="")
