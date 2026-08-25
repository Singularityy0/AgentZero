// Include necessary header
#include <iostream>
#include <vector>
#include <algorithm>

// Function to merge two halves and count inversions
long long mergeAndCount(std::vector<int>& arr, int left, int mid, int right) {
    int n1 = mid - left + 1;
    int n2 = right - mid;
    std::vector<int> leftArr(n1), rightArr(n2);

    // Copy data to temporary arrays leftArr[] and rightArr[]
    for (int i = 0; i < n1; i++)
        leftArr[i] = arr[left + i];
    for (int i = 0; i < n2; i++)
        rightArr[i] = arr[mid + 1 + i];

    int i = 0, j = 0, k = left, swaps = 0;

    // Merge the temporary arrays back into arr[left..right]
    while (i < n1 && j < n2) {
        if (leftArr[i] <= rightArr[j]) {
            arr[k++] = leftArr[i++];
        } else {
            arr[k++] = rightArr[j++];
            swaps += (mid + 1) - (left + i);
        }
    }

    // Copy the remaining elements of leftArr[], if any
    while (i < n1)
        arr[k++] = leftArr[i++];

    // Copy the remaining elements of rightArr[], if any
    while (j < n2)
        arr[k++] = rightArr[j++];

    return swaps;
}

// Function to implement merge sort and count inversions
long long mergeSortAndCount(std::vector<int>& arr, int left, int right) {
    long long inversions = 0;
    if (left < right) {
        int mid = left + (right - left) / 2;

        inversions += mergeSortAndCount(arr, left, mid);
        inversions += mergeSortAndCount(arr, mid + 1, right);

        inversions += mergeAndCount(arr, left, mid, right);
    }
    return inversions;
}

// Function to count inversions in the array
long long countInversions(std::vector<int>& arr) {
    return mergeSortAndCount(arr, 0, arr.size() - 1);
}

// Main function for testing
int main() {
    std::vector<int> arr = {8, 4, 2, 1};
    std::cout << "Number of inversions are " << countInversions(arr) << std::endl;
    return 0;
}
