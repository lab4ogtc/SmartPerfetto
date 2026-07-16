// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"net"
	"strconv"
	"strings"
	"testing"
)

func TestResolveServicePortsFallsBackWhenDefaultFrontendPortIsBusy(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("SMARTPERFETTO_BACKEND_PORT", "")
	t.Setenv("SMARTPERFETTO_FRONTEND_PORT", "")

	listener, err := net.Listen("tcp", ":"+defaultFrontendPort)
	if err != nil {
		t.Logf("default frontend port %s is already unavailable: %v", defaultFrontendPort, err)
	} else {
		defer listener.Close()
	}

	backendPort, frontendPort, err := resolveServicePorts()
	if err != nil {
		t.Fatalf("resolve service ports: %v", err)
	}
	if backendPort == frontendPort {
		t.Fatalf("backend and frontend ports should differ, got %s", backendPort)
	}
	if frontendPort == defaultFrontendPort {
		t.Fatalf("expected busy default frontend port to be replaced")
	}
}

func TestResolveServicePortsRejectsBusyExplicitFrontendPort(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("SMARTPERFETTO_BACKEND_PORT", "")

	listener, port := reserveTestPort(t)
	defer listener.Close()
	t.Setenv("SMARTPERFETTO_FRONTEND_PORT", port)

	_, _, err := resolveServicePorts()
	if err == nil {
		t.Fatalf("expected busy explicit frontend port to be rejected")
	}
	if !strings.Contains(err.Error(), "frontend port "+port) {
		t.Fatalf("expected actionable frontend port error, got %q", err.Error())
	}
}

func reserveTestPort(t *testing.T) (net.Listener, string) {
	t.Helper()
	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("reserve test port: %v", err)
	}
	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("expected TCP address, got %T", listener.Addr())
	}
	return listener, strconv.Itoa(tcpAddr.Port)
}
