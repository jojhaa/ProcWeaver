package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGeoCandidates(t *testing.T) {
	for kind, name := range map[string]string{"mmdb": "geoip.metadb", "asn": "GeoLite2-ASN.mmdb", "geoip": "geoip.dat", "geosite": "geosite.dat"} {
		t.Run(kind, func(t *testing.T) {
			source := filepath.Join("..", "..", "..", "core_data", name)
			if err := validateGeoFile(kind, source); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), name)
			if err := os.WriteFile(path, []byte("<html>not a database</html>"), 0600); err != nil {
				t.Fatal(err)
			}
			if validateGeoFile(kind, path) == nil {
				t.Fatal("HTML accepted")
			}
			data, err := os.ReadFile(source)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(path, data[:len(data)/2], 0600); err != nil {
				t.Fatal(err)
			}
			if validateGeoFile(kind, path) == nil {
				t.Fatal("truncated candidate accepted")
			}
		})
	}
}
