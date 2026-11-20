// Command line of the PGM helper: the UTF-8 argument list the platform host
// hands to main.cpp must parse exactly like the argc/argv form it replaced.
#include "common/pgm_options.h"

#include <cstdlib>
#include <iostream>

using namespace broadify::pgm;

static void fail(const char *m) { std::cerr << "pgm_options_test failed: " << m << std::endl; std::exit(1); }

int main() {
  // What the bridge passes (helper-launch): socket path with a non-ASCII user name stays byte-identical.
  const std::vector<std::string> args = {"pgm-helper", "--run", "--control-socket", "/tmp/J\xC3\xBCrgen/pgm.sock", "--parent-pid", "4242",
                                         "--event-log", "/tmp/pgm-events.jsonl", "--synthetic-source", "1920x1080@59.94", "--log-perf"};
  const PgmOptions o = parsePgmOptions(args);
  if (!o.run || o.probe) fail("--run");
  if (o.controlSocket != "/tmp/J\xC3\xBCrgen/pgm.sock") fail("--control-socket");
  if (o.parentPid != 4242) fail("--parent-pid");
  if (o.eventLogPath != "/tmp/pgm-events.jsonl") fail("--event-log");
  if (o.syntheticSource != "1920x1080@59.94") fail("--synthetic-source");
  if (!o.logPerf) fail("--log-perf");

  // The argc/argv form gives the same result.
  std::vector<char *> argv;
  std::vector<std::string> storage = args;
  for (std::string &arg : storage) argv.push_back(&arg[0]);
  const PgmOptions c = parsePgmOptions(static_cast<int>(argv.size()), argv.data());
  if (c.run != o.run || c.probe != o.probe || c.controlSocket != o.controlSocket || c.parentPid != o.parentPid ||
      c.eventLogPath != o.eventLogPath || c.syntheticSource != o.syntheticSource || c.logPerf != o.logPerf) {
    fail("argc/argv form must match the argument list form");
  }

  // args[0] is the program name and never an option; a flag without its value is ignored.
  const PgmOptions p = parsePgmOptions(std::vector<std::string>{"--run", "--probe", "--control-socket", "x", "--parent-pid"});
  if (p.run || !p.probe || p.parentPid != -1) fail("program name / trailing flag");
  const PgmOptions empty = parsePgmOptions(std::vector<std::string>{});
  if (empty.run || empty.probe || empty.parentPid != -1) fail("empty argument list");

  uint32_t w = 0, h = 0;
  double fps = 0.0;
  if (!parseSyntheticSpec("1080x1920@30", w, h, fps) || w != 1080 || h != 1920 || fps != 30.0) fail("synthetic spec");
  if (parseSyntheticSpec("1920@60", w, h, fps) || parseSyntheticSpec("8x8@60", w, h, fps)) fail("malformed synthetic spec");

  std::cout << "pgm_options_test passed" << std::endl;
  return 0;
}
