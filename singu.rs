// SPFA algorithm implementation in Rust

use std::collections::VecDeque;

fn spfa(graph: &Vec<Vec<(usize, i32)>>, source: usize, n: usize) -> Vec<i32> {
    let mut dist = vec![i32::MAX; n];
    dist[source] = 0;
    let mut queue = VecDeque::new();
    queue.push_back(source);
    let mut in_queue = vec![false; n];
    in_queue[source] = true;

    while let Some(u) = queue.pop_front() {
        in_queue[u] = false;
        for &(v, weight) in &graph[u] {
            if dist[u] + weight < dist[v] {
                dist[v] = dist[u] + weight;
                if !in_queue[v] {
                    queue.push_back(v);
                    in_queue[v] = true;
                }
            }
        }
    }

    dist
}