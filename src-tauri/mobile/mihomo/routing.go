package main

import (
	"regexp"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

type routeSnapshot struct {
	Rules      []string            `yaml:"rules"`
	SubRules   map[string][]string `yaml:"sub-rules"`
	Proxies    []map[string]any    `yaml:"proxies"`
	Groups     []map[string]any    `yaml:"proxy-groups"`
	Selections map[string]string   `yaml:"procweaver-bundle-selections"`
}

func readRoutes(raw string) (routeSnapshot, error) {
	var result routeSnapshot
	err := yaml.Unmarshal([]byte(raw), &result)
	return result, err
}

var packageRule = regexp.MustCompile(`(?:^|[,(])PROCESS-NAME,([^,()]+)`)

// Include referenced sub-rules and outbound definitions, so removing a package
// rule, changing a sandbox, or selecting another bundle exit retires its old flows.
// Unrelated package rules and unrelated exit selections do not interrupt traffic.
func (s routeSnapshot) packages() map[string]string {
	definitions := make(map[string]any)
	for _, items := range [][]map[string]any{s.Proxies, s.Groups} {
		for _, item := range items {
			if name, ok := item["name"].(string); ok {
				definitions[name] = item
			}
		}
	}
	for name, rules := range s.SubRules {
		definitions[name] = rules
	}
	var expand func(string, map[string]bool) string
	expand = func(value string, visited map[string]bool) string {
		result := value
		for _, token := range strings.FieldsFunc(value, func(c rune) bool { return c == ',' || c == '(' || c == ')' }) {
			token = strings.TrimSpace(token)
			if visited[token] {
				continue
			}
			definition, ok := definitions[token]
			if !ok {
				continue
			}
			visited[token] = true
			if selection, ok := s.Selections[token]; ok {
				result += "\x00" + expand(selection, visited)
				continue
			}
			encoded, _ := yaml.Marshal(definition)
			result += "\x00" + string(encoded)
			switch item := definition.(type) {
			case []string:
				for _, rule := range item {
					result += "\x00" + expand(rule, visited)
				}
			case map[string]any:
				if members, ok := item["proxies"].([]any); ok {
					for _, member := range members {
						if name, ok := member.(string); ok {
							result += "\x00" + expand(name, visited)
						}
					}
				}
			}
		}
		return result
	}
	result := make(map[string]string)
	collect := func(rules []string) {
		for _, rule := range rules {
			for _, match := range packageRule.FindAllStringSubmatch(rule, -1) {
				result[match[1]] += "\x00" + expand(rule, make(map[string]bool))
			}
		}
	}
	collect(s.Rules)
	// Sorting is required because multiple sub-rules can mention the same package.
	names := make([]string, 0, len(s.SubRules))
	for name := range s.SubRules {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		collect(s.SubRules[name])
	}
	return result
}

func changedPackages(previous, next routeSnapshot) map[string]bool {
	before, after := previous.packages(), next.packages()
	changed := make(map[string]bool)
	for name, signature := range before {
		if after[name] != signature {
			changed[name] = true
		}
	}
	for name, signature := range after {
		if before[name] != signature {
			changed[name] = true
		}
	}
	return changed
}
