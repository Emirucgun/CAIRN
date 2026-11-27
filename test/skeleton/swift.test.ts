import { describe, expect, it } from "vitest";
import { sk } from "./helpers.js";

const SRC = `import Foundation
@testable import App

/// Adds two numbers.
public func add(_ a: Int, to b: Int) -> Int {
    a + b
}

private let secret = "s"
var counter: Int = 0

public final class Store<T: Codable>: Base, Persisting {
    private var items: [T] = []
    public static let shared = Store()

    public init(capacity: Int) {}

    public func put(_ item: T) throws {
        items.append(item)
    }

    fileprivate func compact() {}
}

struct Point: Equatable {
    var x: Double
    func length() -> Double { 0 }
}

enum Direction: String {
    case up, down
    func flipped() -> Direction { self }
}

protocol Persisting {
    var key: String { get }
    func save() throws
}

extension Array where Element: Equatable {
    func uniqued() -> [Element] { self }
}

actor Counter {}

typealias Handler = (Result<Data, Error>) -> Void

private struct Hidden {
    func visible() {}
}
`;

describe("swift skeleton", () => {
  it("extracts functions, properties, classes, structs, enums, protocols, extensions, actors and typealiases", async () => {
    expect((await sk("swift", SRC)).symbols).toEqual([
      "+function add 4-7 | (_ a: Int, to b: Int) -> Int",
      "-const secret 9-9 | ",
      "+variable counter 10-10 | : Int",
      "+class Store 12-23 | <T: Codable>: Base, Persisting",
      "-property Store.items 13-13 | : [T]",
      "+property Store.shared 14-14 | ",
      "+method Store.init 16-16 | (capacity: Int)",
      "+method Store.put 18-20 | (_ item: T) throws",
      "-method Store.compact 22-22 | ()",
      "+struct Point 25-28 | : Equatable",
      "+property Point.x 26-26 | : Double",
      "+method Point.length 27-27 | () -> Double",
      "+enum Direction 30-33 | : String",
      "+method Direction.flipped 32-32 | () -> Direction",
      "+protocol Persisting 35-38 | ",
      "+property Persisting.key 36-36 | : String",
      "+method Persisting.save 37-37 | () throws",
      "+extension Array 40-42 | where Element: Equatable",
      "+method Array.uniqued 41-41 | () -> [Element]",
      "+class Counter 44-44 | ",
      "+type Handler 46-46 | = (Result<Data, Error>) -> Void",
      "-struct Hidden 48-50 | ",
      "-method Hidden.visible 49-49 | ()",
    ]);
  });

  it("collects imported modules", async () => {
    expect((await sk("swift", SRC)).imports).toEqual(["Foundation", "App"]);
  });
});
