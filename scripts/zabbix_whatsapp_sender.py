#!/usr/bin/env python3
"""Ferramenta de linha de comando para enviar alertas do Zabbix via API WhatsApp."""

from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

import requests


def log(msg: str) -> None:
    timestamp = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    sys.stderr.write(f"[{timestamp}] {msg}\n")


class WhatsAppAPIClient:
    def __init__(self, base_url: str, api_token: Optional[str], timeout: float, verify_tls: bool):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.verify_tls = verify_tls
        self.session = requests.Session()
        if api_token:
            self.session.headers.update({"X-API-Token": api_token})

    def _post(self, endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.base_url}{endpoint}"
        body = json.dumps(payload, ensure_ascii=False)
        headers = {"Content-Type": "application/json"}
        log(f"Enviando POST {url} (payload {len(body)} bytes)")
        response = self.session.post(
            url,
            data=body.encode("utf-8"),
            headers=headers,
            timeout=self.timeout,
            verify=self.verify_tls,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Falha na chamada {endpoint}: HTTP {response.status_code} - {response.text[:200]}"
            )
        return response.json()

    def send_text(self, phone: str, message: str, subject: Optional[str]) -> Dict[str, Any]:
        payload = {"phone": phone, "message": message}
        if subject:
            payload["subject"] = subject
        return self._post("/send", payload)

    def send_media(self, phone: str, media: Dict[str, Any], caption: Optional[str]) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"phone": phone, "media": media}
        if caption:
            payload["caption"] = caption
        return self._post("/send-media", payload)


class ZabbixGraphFetcher:
    def __init__(
        self,
        base_url: str,
        timeout: float,
        verify_tls: bool,
        token: Optional[str] = None,
        user: Optional[str] = None,
        password: Optional[str] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.verify_tls = verify_tls
        self.session = requests.Session()
        self.auth_type: Optional[str] = None
        self.token = token
        self.user = user
        self.password = password

    def _api_login(self) -> str:
        api_url = f"{self.base_url}/api_jsonrpc.php"
        payload = {
            "jsonrpc": "2.0",
            "method": "user.login",
            "params": {"user": self.user, "password": self.password},
            "id": 1,
        }
        log("Realizando login na API do Zabbix para obter token...")
        resp = self.session.post(api_url, json=payload, timeout=self.timeout, verify=self.verify_tls)
        data = resp.json()
        if "error" in data:
            raise RuntimeError(f"Falha no login do Zabbix: {data['error']}")
        return data["result"]

    def prepare(self) -> None:
        if self.token:
            self.auth_type = "bearer"
            self.session.headers.update({"Authorization": f"Bearer {self.token}"})
            log("Usando token de API do Zabbix para autenticação.")
            return
        if self.user and self.password:
            token = self._api_login()
            self.auth_type = "legacy"
            self.token = token
            log("Token de autenticação do Zabbix obtido com sucesso.")
            return
        raise RuntimeError("Forneça --zabbix-token ou --zabbix-user/--zabbix-password para baixar o gráfico.")

    def fetch_graph(
        self,
        graph_id: str,
        period: int,
        width: int,
        height: int,
        stime: Optional[str] = None,
    ) -> Tuple[bytes, str]:
        if not self.auth_type:
            self.prepare()
        params: Dict[str, Any] = {"graphid": graph_id, "period": period, "width": width, "height": height}
        if stime:
            params["stime"] = stime
        url = f"{self.base_url}/chart2.php"
        if self.auth_type == "legacy" and self.token:
            params["auth"] = self.token
        log(
            "Baixando gráfico do Zabbix: graph_id=%s period=%s width=%s height=%s"
            % (graph_id, period, width, height)
        )
        response = self.session.get(url, params=params, timeout=self.timeout, verify=self.verify_tls)
        if response.status_code >= 400:
            raise RuntimeError(
                f"Falha ao baixar gráfico: HTTP {response.status_code} - {response.text[:200]}"
            )
        content_type = response.headers.get("Content-Type", "image/png")
        return response.content, content_type


def encode_media(data: bytes, mimetype: str, filename: str) -> Dict[str, str]:
    b64 = base64.b64encode(data).decode("ascii")
    return {"data": b64, "mimetype": mimetype, "filename": filename}


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phone", help="Número de telefone de destino (aceita formatos nacionais ou E.164)")
    parser.add_argument("message", help="Mensagem base a ser enviada")
    parser.add_argument("--subject", help="Assunto opcional para o texto principal")
    parser.add_argument("--caption", help="Legenda opcional para acompanhar o gráfico")
    parser.add_argument("--api-base-url", default="http://localhost:3000", help="URL base da API WhatsApp")
    parser.add_argument("--api-token", help="Token da API WhatsApp (cabeçalho X-API-Token)")
    parser.add_argument("--timeout", type=float, default=15.0, help="Timeout em segundos para requisições HTTP")
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Desabilita verificação de certificado TLS (não recomendado em produção)",
    )

    graph = parser.add_argument_group("Gráfico do Zabbix")
    graph.add_argument("--graph-id", help="ID do gráfico a ser anexado")
    graph.add_argument("--zabbix-url", help="URL base do Zabbix, ex.: https://zabbix.exemplo.com")
    graph.add_argument("--zabbix-token", help="Token de API do Zabbix (Bearer)")
    graph.add_argument("--zabbix-user", help="Usuário do Zabbix para login via API")
    graph.add_argument("--zabbix-password", help="Senha do Zabbix para login via API")
    graph.add_argument("--period", type=int, default=3600, help="Período do gráfico em segundos")
    graph.add_argument("--width", type=int, default=900, help="Largura do gráfico em pixels")
    graph.add_argument("--height", type=int, default=200, help="Altura do gráfico em pixels")
    graph.add_argument(
        "--stime",
        help="Data/hora inicial no formato YYYYMMDDHHMMSS (opcional, substitui o período padrão)",
    )
    graph.add_argument(
        "--graph-filename",
        default="zabbix-graph.png",
        help="Nome do arquivo a ser enviado no WhatsApp",
    )

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    verify_tls = not args.insecure

    client = WhatsAppAPIClient(args.api_base_url, args.api_token, args.timeout, verify_tls)

    try:
        log("Enviando mensagem de texto...")
        client.send_text(args.phone, args.message, args.subject)
    except Exception as exc:  # noqa: BLE001
        log(f"Falha ao enviar mensagem de texto: {exc}")
        return 2

    if args.graph_id:
        if not args.zabbix_url:
            parser.error("--zabbix-url é obrigatório quando --graph-id for utilizado")
        fetcher = ZabbixGraphFetcher(
            base_url=args.zabbix_url,
            timeout=args.timeout,
            verify_tls=verify_tls,
            token=args.zabbix_token,
            user=args.zabbix_user,
            password=args.zabbix_password,
        )
        try:
            data, mimetype = fetcher.fetch_graph(
                graph_id=args.graph_id,
                period=args.period,
                width=args.width,
                height=args.height,
                stime=args.stime,
            )
            media = encode_media(data, mimetype, args.graph_filename)
            caption = args.caption or args.message
            log("Enviando gráfico como mídia...")
            client.send_media(args.phone, media, caption)
        except Exception as exc:  # noqa: BLE001
            log(f"Falha ao enviar mídia: {exc}")
            return 3

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
