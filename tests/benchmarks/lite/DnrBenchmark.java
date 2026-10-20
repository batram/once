package com.zmarn.once.lite;

import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Host-JVM throughput/allocation probe; run with scripts/benchmark-lite-dnr.js. */
public final class DnrBenchmark {
    public static void main(String[] args) throws Exception {
        com.sun.management.ThreadMXBean memory = (com.sun.management.ThreadMXBean) ManagementFactory.getThreadMXBean();
        long thread = Thread.currentThread().threadId();
        List<DnrEvaluator.Compiled> parts = new ArrayList<>();
        long started = System.nanoTime();
        int count = 0;
        for (String id : new String[] { "ublock-filters", "easylist", "easyprivacy" }) {
            for (String kind : new String[] { "main", "regex" }) {
                Path file = Paths.get(args[0], kind, id + ".json");
                if (!Files.isRegularFile(file)) continue;
                DnrEvaluator.Compiled part = DnrEvaluator.compileArray(Files.readString(file));
                parts.add(part);
                count += part.rules.size();
            }
        }
        if (count == 0) throw new IllegalStateException("Fetch the bundled extensions before benchmarking");
        DnrEvaluator evaluator = new DnrEvaluator(Collections.singletonList(DnrEvaluator.group("ubo", null, parts)));
        System.out.println("rules=" + count + " compile_ms=" + (System.nanoTime() - started) / 1e6);
        for (int length : new int[] { 100, 32000 }) {
            DnrEvaluator.Request[] requests = new DnrEvaluator.Request[50];
            for (int index = 0; index < requests.length; index++) {
                String base = "https://cdn.news.example/static/app." + index + ".js?";
                String url = base + "a&k=v%2f".repeat(Math.max(0, (length - base.length()) / 8));
                requests[index] = new DnrEvaluator.Request(url, "script", "GET", "https://news.example/", 1, null);
            }
            for (int index = 0; index < 1000; index++) evaluator.evaluate(requests[index % requests.length]);
            for (int round = 0; round < 5; round++) {
                started = System.nanoTime();
                long allocated = memory.getThreadAllocatedBytes(thread);
                int iterations = length == 100 ? 5000 : 200;
                for (int index = 0; index < iterations; index++) evaluator.evaluate(requests[index % requests.length]);
                System.out.println("length=" + length + " round=" + round + " us=" + (System.nanoTime() - started) / 1e3 / iterations
                    + " allocated_bytes=" + (memory.getThreadAllocatedBytes(thread) - allocated) / iterations);
            }
        }
    }
}
