package main

import (
	"errors"
	"github.com/metacubex/mihomo/component/geodata/router"
	"github.com/oschwald/maxminddb-golang"
	"google.golang.org/protobuf/proto"
	"os"
)

// Parse an isolated candidate without changing global core paths or live caches.
func validateGeoFile(kind, path string) error {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 16 || info.Size() > 128*1024*1024 {
		return errors.New("invalid Geo candidate")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	switch kind {
	case "mmdb", "asn":
		db, err := maxminddb.FromBytes(data)
		if err != nil {
			return err
		}
		defer db.Close()
		if db.Metadata.NodeCount == 0 {
			return errors.New("empty Geo database")
		}
		// Community MMDB files may omit optional descriptive metadata. Decode every
		// reachable network to check the actual search tree and records instead.
		networks := db.Networks(maxminddb.SkipAliasedNetworks)
		count := 0
		for networks.Next() {
			var record any
			if _, err := networks.Network(&record); err != nil {
				return err
			}
			if record == nil {
				return errors.New("empty Geo record")
			}
			count++
		}
		if err := networks.Err(); err != nil {
			return err
		}
		if count == 0 {
			return errors.New("empty Geo database")
		}
		return nil
	case "geoip":
		var list router.GeoIPList
		if err := proto.Unmarshal(data, &list); err != nil {
			return err
		}
		if len(list.Entry) == 0 {
			return errors.New("empty GeoIP database")
		}
		for _, entry := range list.Entry {
			for _, cidr := range entry.Cidr {
				if (len(cidr.Ip) != 4 && len(cidr.Ip) != 16) || cidr.Prefix > uint32(len(cidr.Ip)*8) {
					return errors.New("invalid GeoIP prefix")
				}
			}
		}
	case "geosite":
		var list router.GeoSiteList
		if err := proto.Unmarshal(data, &list); err != nil {
			return err
		}
		if len(list.Entry) == 0 {
			return errors.New("empty GeoSite database")
		}
		for _, entry := range list.Entry {
			if entry.CountryCode == "" || len(entry.Domain) == 0 {
				return errors.New("invalid GeoSite entry")
			}
		}
	default:
		return errors.New("unknown Geo type")
	}
	return nil
}
